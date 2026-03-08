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

    console.log("3. Chamando Motor de Edição (InstructPix2Pix c/ Smart Prompt)...");

    // Construção de Prompt de Instrução Direta (Como o ChatGPT faz)
    // O InstructPix2Pix não descreve a foto final, ele fala O QUE ALTERAR na foto original.
    const instructPrompt = `Add a ${productTitle} ${placementPrompt}. Make it ${promptExtra}. Do not change the dog's body, face, or background.`;

    // Pivotando de SDXL (que derretia o cachorro) para o InstructPix2Pix (Edição Inteligente)
    const output = await replicate.run(
      "timbrooks/instruct-pix2pix:30c1d0b916a6f8efce20492f5d61ee27491ab2a60437c13c588468b9810ec23f",
      {
        input: {
          image: originalPetUrl,
          prompt: instructPrompt,
          negative_prompt: "deformed face, changed background, altered dog breed, bad anatomy, ugly, artifacts",
          num_outputs: 1,
          image_guidance_scale: 1.5, // 1.5 é o padrão perfeito para manter o cachorro intacto
          guidance_scale: 7.5,       // Força da instrução de adicionar o produto
          num_inference_steps: 50    // Máximo de cuidado nos detalhes
        }
      }
    );

    const generatedImageUrl = output[0]; // Retorno do Replicate

    console.log("4. Salvando a arte final...");
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
