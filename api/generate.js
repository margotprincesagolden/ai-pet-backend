import { v2 as cloudinary } from 'cloudinary';
import Replicate from 'replicate';
import Cors from 'cors';

// Middleware do CORS (Shopify -> Vercel)
const cors = Cors({
  methods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
  origin: '*'
});

// Helper de Execução Middleware
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

// Configura o Cloudinary Seguramente via .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Autentica no Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// O Sistema Principal de Geração (Advanced IP-Adapter & Smart Dictionary)
export default async function handler(req, res) {
  await runMiddleware(req, res, cors);

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Método não permitido.' });
  }

  try {
    // Agora recebemos a foto do Pet E do Produto vindo da Shopify
    const { imageBase64, productImageBase64, productTitle, promptExtra } = req.body;

    if (!imageBase64 || !productImageBase64) {
      return res.status(400).json({ error: 'Faltam imagens (Pet ou Produto) para a mágica.' });
    }

    console.log("1. Fazendo upload de ambas as fotos para o Cloudinary...");

    // Sobe a foto do Cachorro
    const petUpload = await cloudinary.uploader.upload(imageBase64, { folder: 'ai_pet_uploads' });
    const originalPetUrl = petUpload.secure_url;

    // Sobe a foto do Produto Original (Referência Material/Cor para a IA)
    const productUpload = await cloudinary.uploader.upload(productImageBase64, { folder: 'ai_product_refs' });
    const productRefUrl = productUpload.secure_url;

    console.log("2. Aplicando o SMART PLACEMENT DICTIONARY...");
    let placementPrompt = "";
    let basePrompt = "A highly detailed, professional studio photography of a cute pet";
    const titleLower = productTitle.toLowerCase();

    // Dicionário de Posicionamento Lógico
    if (titleLower.includes("bandana") || titleLower.includes("coleira") || titleLower.includes("guia")) {
      placementPrompt = "perfectly wrapped around the pet's neck, neckwear focus";
    }
    else if (titleLower.includes("laço") || titleLower.includes("laco") || titleLower.includes("presilha")) {
      placementPrompt = "placed elegantly on top of the pet's head, between the ears, hair accessory focus";
    }
    else if (titleLower.includes("kit")) {
      placementPrompt = "wearing matching accessories around the neck and on top of the head";
    }
    else {
      // Fallback se não detectar
      placementPrompt = "wearing the accessory beautifully";
    }

    // Unindo toda a lógica textual
    const finalPrompt = `${basePrompt} ${placementPrompt}, the accessory is ${promptExtra}, exact material and pattern as the reference, luxury e-commerce product shot, soft studio lighting, 8k resolution, photorealistic, cinematic, sharp focus`;
    const negativePrompt = "ugly, blurry, deformed face, bad anatomy, human hands, text, watermark, cartoon, animated, low res, oversaturated, messy fur, floating accessories";

    console.log("3. Analisando a foto do Cachorro com Visão LLaVA (Para recriar)...");

    // Passo A: A IA Analisa o cachorro real e escreve uma descrição detalhada dele
    const visionOutput = await replicate.run(
      "yorickvp/llava-13b:b5f621affc37f12539a441e3c11396a31173bb23f79ef9ae521714fc2ee81a26",
      {
        input: {
          image: originalPetUrl,
          prompt: "Describe this dog in extreme detail: breed, fur color, expression, pose, and the exact background environment. Be concise and descriptive.",
          max_tokens: 150
        }
      }
    );

    // Junta a resposta do LLaVA (Array de strings -> String única)
    const dogDescription = Array.isArray(visionOutput) ? visionOutput.join("") : visionOutput;
    console.log("-> Cão mapeado:", dogDescription);

    console.log("4. Criando Arte Mágica Final com Seedream-4...");

    // Passo B: Fundimos a descrição real do cão com o detalhamento de luxo do produto
    const seedreamPrompt = `A stunning, hyper-realistic tracking shot of ${dogDescription}. The dog is ${placementPrompt} a ${productTitle}. The accessory details: ${promptExtra}. Matches the exact material and pattern of a high-end fashion piece. 8k resolution, photorealistic masterpiece, natural lighting.`;

    // O modelo aprovado pelo cliente: Bytedance Seedream 4 (Altíssima qualidade de síntese)
    const output = await replicate.run(
      "bytedance/seedream-4:cf7d431991436f19d1c8dad83fe463c729c816d7a21056c5105e75c84a0aa7e9",
      {
        input: {
          prompt: seedreamPrompt,
          size: "1024x1024", // Formato HQ
          max_images: 1
        }
      }
    );

    const generatedImageUrl = Array.isArray(output) ? output[0] : output; // Retorno do Seedream

    console.log("5. Salvando a arte final...");
    const finalResult = await cloudinary.uploader.upload(generatedImageUrl, {
      folder: 'ai_pet_generated',
    });

    return res.status(200).json({
      success: true,
      generatedImage: finalResult.secure_url,
      originalPet: originalPetUrl,
      productRef: productRefUrl
    });

  } catch (error) {
    console.error("Erro Crítico no Pipeline de IA:", error);
    return res.status(500).json({ error: 'Erro ao gerar a fusão na Vercel.', details: error.message });
  }
}
