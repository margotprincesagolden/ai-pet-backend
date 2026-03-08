import { v2 as cloudinary } from 'cloudinary';
import Replicate from 'replicate';
import Cors from 'cors';

// ============================================================
//  MARGOT & MARGARIDAS — AI Pet Studio v4.0
//  Pipeline: flux-kontext-apps/multi-image-kontext-pro
//  Estratégia: passa DUAS imagens reais (pet + produto) para a IA
//  → cachorro idêntico ao original + produto visualmente fiel
//  → mesmo resultado que o ChatGPT com duas imagens
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

    // ── STEP 3: Construção do Prompt de Fusão ──
    // Multi-image Kontext recebe as DUAS fotos reais — pet e produto
    // O prompt instrui COMO unir as duas, sem inventar nada
    console.log("STEP 3 → Construindo prompt de fusão...");
    const ctx = buildPlacementContext(productTitle || "", promptExtra || "");
    const productDetails = promptExtra ? promptExtra : productTitle;

    // Prompt de fusão: referencia "first image" (pet) e "second image" (produto)
    // Kontext entende essa linguagem para saber o papel de cada imagem
    const fusionPrompt = [
      // Âncora do pet (primeira imagem)
      `Keep the dog from the first image exactly as it is — same breed, fur, face, expression and pose`,
      // Âncora do produto (segunda imagem)
      `Take the accessory from the second image and place it on the dog: ${ctx.placement}`,
      // Detalhe específico do produto
      `Reproduce the exact colors, fabric, pattern and texture of the accessory from the second image`,
      // Instruções de qualidade
      ctx.styleBoost,
      // Estilo fotográfico final
      `Professional pet fashion photography, soft studio lighting, sharp focus on face and accessory, photorealistic, 8k quality`
    ].join(". ");

    console.log("   Prompt de fusão:", fusionPrompt);

    // ── STEP 4: Fusão com multi-image-kontext-pro ──
    // Modelo recebe pet (image_1) + produto (image_2) + prompt
    // Resultado: o cachorro real usando o produto real
    console.log("STEP 4 → Fundindo imagens com multi-image-kontext-pro...");

    // Garante que temos a imagem do produto — obrigatória aqui
    if (!productRefUrl) {
      throw new Error("Imagem do produto obrigatória para a fusão multi-imagem.");
    }

    let generatedImageUrl;

    async function runMultiImageKontext(petUrl, productUrl, prompt) {
      const response = await fetch("https://api.replicate.com/v1/models/flux-kontext-apps/multi-image-kontext-pro/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            image_1: petUrl,       // Foto real do cachorro do cliente
            image_2: productUrl,   // Foto real do produto da loja
            prompt: fusionPrompt,
            aspect_ratio: "1:1",
            safety_tolerance: 2,
            output_format: "webp",
            output_quality: 95
          }
        }),
      });

      if (!response.ok) {
        const errDesc = await response.text();
        throw new Error(`Multi-Image Kontext API Error ${response.status}: ${errDesc}`);
      }

      let prediction = await response.json();
      const predictionId = prediction.id;

      while (prediction.status !== "succeeded" && prediction.status !== "failed") {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
          headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
        });
        prediction = await poll.json();
        console.log(`   [Multi-Kontext Polling] status: ${prediction.status}`);
      }

      if (prediction.status === "failed") {
        throw new Error("Multi-Image Kontext falhou: " + prediction.error);
      }

      return prediction.output;
    }

    try {
      const multiOutput = await runMultiImageKontext(petImageUrl, productRefUrl, fusionPrompt);
      generatedImageUrl = Array.isArray(multiOutput) ? multiOutput[0] : multiOutput;
      console.log("   Multi-Image Kontext Pro sucesso:", generatedImageUrl);

    } catch (multiError) {
      // Fallback: Kontext Pro com apenas a foto do pet (sem a ref do produto)
      console.warn("   Multi-Image falhou, usando Kontext Pro single-image como fallback...", multiError.message);

      const fallbackPrompt = [
        `Add ${ctx.placement} to the dog in this photo`,
        `The accessory details: ${productDetails}`,
        ctx.styleBoost,
        `Keep the dog's appearance exactly the same`,
        `Professional pet photography, photorealistic`
      ].join(". ");

      const fbResponse = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            input_image: petImageUrl,
            prompt: fallbackPrompt,
            output_format: "webp",
            output_quality: 92,
            safety_tolerance: 2,
            aspect_ratio: "1:1"
          }
        }),
      });

      let fbPrediction = await fbResponse.json();
      const fbId = fbPrediction.id;

      while (fbPrediction.status !== "succeeded" && fbPrediction.status !== "failed") {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(`https://api.replicate.com/v1/predictions/${fbId}`, {
          headers: { "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}` }
        });
        fbPrediction = await poll.json();
        console.log(`   [Fallback Polling] status: ${fbPrediction.status}`);
      }

      if (fbPrediction.status === "failed") throw new Error("Fallback também falhou: " + fbPrediction.error);

      const fbOutput = fbPrediction.output;
      generatedImageUrl = Array.isArray(fbOutput) ? fbOutput[0] : fbOutput;
      console.log("   Fallback Kontext Pro sucesso:", generatedImageUrl);
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
      promptUsed: fusionPrompt  // Debug helper — remova em produção
    });

  } catch (error) {
    console.error("❌ Erro crítico no pipeline:", error);
    return res.status(500).json({
      error: `Pipeline Error: ${error.message}`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
