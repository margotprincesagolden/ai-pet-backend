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

    console.log("3. Chamando Motor Avançado com Fusão de Imagem (IP-Adapter/SDXL)...");

    // Mudamos o modelo do básico (Image2Image normal) para um que aceita IP-Adapter
    // O hysts/ip-adapter-sdxl injeta a imagem de referência (produto) direto na geração
    const output = await replicate.run(
      "hysts/ip-adapter-sdxl:8e29a8a7061b4db1b369cc24d101d7e283ab2964fe5fac1136b6fba30da57f07",
      {
        input: {
          image: originalPetUrl,                // A foto base (o Cachorro)
          ip_adapter_image: productRefUrl,      // A foto referência (o Laço/Bandana) para roubar cor/tecido
          prompt: finalPrompt,                  // Direcionamento lógico de onde a peça vai
          negative_prompt: negativePrompt,
          scale: 0.65,                          // Força da textura do produto
          control_scale: 0.70,                  // Manter a estrutura do cachorro intacta
          num_outputs: 1,
          num_inference_steps: 40
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
