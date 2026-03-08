import { v2 as cloudinary } from 'cloudinary';
import Replicate from 'replicate';
import Cors from 'cors';

// ============================================================
//  MARGOT & MARGARIDAS — AI Pet Studio v3.0
//  Pipeline: FLUX.1 Kontext Pro (edição com identidade preservada)
//  Modelo Principal: black-forest-labs/flux-kontext-pro
//  Estratégia: edita a foto REAL do pet adicionando o acessório
//  → cachorro idêntico ao original, acessório correto e fiel
// ============================================================

const cors = Cors({
  methods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
  origin: '*'
});

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// ─── DICIONÁRIO DE ACESSÓRIOS ─────────────────────────────────────────────────
// Define onde e como cada peça aparece no corpo do pet
function buildPlacementContext(productTitle, promptExtra) {
  const t = productTitle.toLowerCase();

  const placements = [
    {
      keywords: ["bandana"],
      placement: "wearing a bandana tied around the neck",
      focus: "neck accessory, bandana visible and prominent",
      styleBoost: "fabric texture clearly visible, knot centered on chest"
    },
    {
      keywords: ["coleira", "collar"],
      placement: "wearing a collar around the neck",
      focus: "collar clearly visible around neck",
      styleBoost: "collar fit snugly, hardware and texture sharp"
    },
    {
      keywords: ["guia", "lead", "leash"],
      placement: "with a leash attached to collar",
      focus: "leash and collar system visible",
      styleBoost: "hardware gleaming, leash draping naturally"
    },
    {
      keywords: ["laço", "laco", "bow", "presilha", "hair", "topknot"],
      placement: "with a bow placed on top of the head between the ears",
      focus: "hair bow on head as focal point",
      styleBoost: "bow centered between ears, ribbon symmetrical"
    },
    {
      keywords: ["kit", "conjunto", "set"],
      placement: "wearing a matching accessory set: bandana around the neck and a bow on top of the head",
      focus: "coordinated matching accessories",
      styleBoost: "both pieces visible, same fabric pattern connecting them"
    },
    {
      keywords: ["mochila", "bag", "backpack"],
      placement: "wearing a small pet backpack on the back",
      focus: "backpack straps and body visible",
      styleBoost: "backpack properly fitted, straps symmetrical"
    },
  ];

  for (const entry of placements) {
    if (entry.keywords.some(k => t.includes(k))) {
      return entry;
    }
  }

  // Fallback genérico
  return {
    placement: `wearing ${productTitle} as an accessory`,
    focus: "accessory clearly visible on pet",
    styleBoost: "accessory well-fitted and prominent"
  };
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  await runMiddleware(req, res, cors);

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Método não permitido.' });
  }

  try {
    const { imageBase64, productImageBase64, productTitle, promptExtra } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Foto do pet obrigatória.' });
    }

    // ── STEP 1: Upload do pet para o Cloudinary (necessário para URL pública) ──
    console.log("STEP 1 → Upload do pet para Cloudinary...");
    const petUpload = await cloudinary.uploader.upload(imageBase64, {
      folder: 'mm_pet_uploads',
      transformation: [
        { width: 1024, height: 1024, crop: 'limit' }, // Limita tamanho para otimizar
        { quality: 'auto:best' }
      ]
    });
    const petImageUrl = petUpload.secure_url;
    console.log("   Pet URL:", petImageUrl);

    // ── STEP 2: Upload do produto (se disponível) ──
    let productRefUrl = null;
    if (productImageBase64) {
      console.log("STEP 2 → Upload da referência do produto...");
      const prodUpload = await cloudinary.uploader.upload(productImageBase64, {
        folder: 'mm_product_refs'
      });
      productRefUrl = prodUpload.secure_url;
      console.log("   Produto URL:", productRefUrl);
    }

    // ── STEP 3: Construção do Prompt de Edição ──
    // Kontext edita a foto REAL — então o prompt instrui "o que adicionar/mudar"
    // NÃO precisa descrever o cachorro — ele já está na imagem
    console.log("STEP 3 → Construindo prompt de edição para Kontext...");
    const ctx = buildPlacementContext(productTitle || "", promptExtra || "");

    const productDetails = promptExtra ? promptExtra : productTitle;

    // Prompt de edição: instrução clara do que fazer na foto
    // Kontext entende linguagem natural de edição ("add X to Y", "keep everything else")
    const editPrompt = [
      // Instrução de edição direta
      `Add ${ctx.placement} to the dog in this photo`,
      // Detalhes visuais do acessório
      `The accessory is ${productDetails}`,
      // Instruções de qualidade do produto
      ctx.styleBoost,
      // Preservação do animal
      "Keep the dog's appearance, breed, fur, face and pose exactly the same",
      // Qualidade final
      "Professional pet photography lighting, sharp focus, photorealistic"
    ].join(". ");

    console.log("   Prompt de edição:", editPrompt);

    // ── STEP 4: Edição com FLUX.1 Kontext Pro ──
    // ESTRATÉGIA CORRETA: Kontext recebe a foto real do pet e adiciona o acessório
    // O cachorro permanece 100% idêntico ao original — só o acessório é adicionado
    console.log("STEP 4 → Editando foto com FLUX.1 Kontext Pro...");

    let generatedImageUrl;

    // Kontext Pro — chamada via modelo com slug direto (sem version hash necessário)
    async function runKontextPro(inputImageUrl, prompt) {
      const response = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
          "Prefer": "wait"
        },
        body: JSON.stringify({
          input: {
            input_image: inputImageUrl,
            prompt: prompt,
            output_format: "webp",
            output_quality: 95,
            safety_tolerance: 2,
            aspect_ratio: "1:1"
          }
        }),
      });

      if (!response.ok) {
        const errDesc = await response.text();
        throw new Error(`Kontext API Error ${response.status}: ${errDesc}`);
      }

      let prediction = await response.json();
      const predictionId = prediction.id;

      // Polling até terminar
      while (prediction.status !== "succeeded" && prediction.status !== "failed") {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
          headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
        });
        prediction = await poll.json();
        console.log(`   [Kontext Polling] status: ${prediction.status}`);
      }

      if (prediction.status === "failed") {
        throw new Error("Kontext falhou: " + prediction.error);
      }

      return prediction.output;
    }

    try {
      const kontextOutput = await runKontextPro(petImageUrl, editPrompt);
      generatedImageUrl = Array.isArray(kontextOutput) ? kontextOutput[0] : kontextOutput;
      console.log("   Kontext Pro sucesso:", generatedImageUrl);

    } catch (kontextError) {
      // Fallback: Kontext Dev (open-weight, sem custo de licença)
      console.warn("   Kontext Pro falhou, tentando Kontext Dev...", kontextError.message);

      const devResponse = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-dev/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            input_image: petImageUrl,
            prompt: editPrompt,
            output_format: "webp",
            output_quality: 90,
            num_inference_steps: 28,
            guidance: 3.5
          }
        }),
      });

      let devPrediction = await devResponse.json();
      const devId = devPrediction.id;

      while (devPrediction.status !== "succeeded" && devPrediction.status !== "failed") {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(`https://api.replicate.com/v1/predictions/${devId}`, {
          headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
        });
        devPrediction = await poll.json();
        console.log(`   [Kontext Dev Polling] status: ${devPrediction.status}`);
      }

      if (devPrediction.status === "failed") throw new Error("Kontext Dev também falhou: " + devPrediction.error);

      const devOutput = devPrediction.output;
      generatedImageUrl = Array.isArray(devOutput) ? devOutput[0] : devOutput;
      console.log("   Kontext Dev fallback sucesso:", generatedImageUrl);
    }

    // ── STEP 5: Salva resultado no Cloudinary ──
    console.log("STEP 5 → Salvando resultado no Cloudinary...");
    const finalResult = await cloudinary.uploader.upload(generatedImageUrl, {
      folder: 'mm_generated_results',
      transformation: [
        { width: 1200, height: 1200, crop: 'limit' },
        { quality: 'auto:best', fetch_format: 'auto' }
      ]
    });

    console.log("✅ Pipeline concluído com sucesso!");

    return res.status(200).json({
      success: true,
      generatedImage: finalResult.secure_url,
      originalPet: petImageUrl,
      productRef: productRefUrl,
      promptUsed: editPrompt  // Debug helper — remova em produção
    });

  } catch (error) {
    console.error("❌ Erro crítico no pipeline:", error);
    return res.status(500).json({
      error: `Pipeline Error: ${error.message}`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
