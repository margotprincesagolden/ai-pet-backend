import { v2 as cloudinary } from 'cloudinary';
import Replicate from 'replicate';
import Cors from 'cors';

// Middleware do CORS para permitir que a Shopify (ou qualquer site) chame essa API
const cors = Cors({
  methods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
  origin: '*' // Em produção, mude para: 'https://sua-loja.myshopify.com'
});

// Helper para rodar o middleware
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

// Configura o Cloudinary com as chaves que você me passou
// Aqui usamos process.env para que a chave secreta não vaze no código da Shopify!
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

export default async function handler(req, res) {
  // Roda o CORS
  await runMiddleware(req, res, cors);

  // Só aceitamos método POST (envio de dados)
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Método não permitido.' });
  }

  try {
    const { imageBase64, promptExtra } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Nenhuma foto do pet foi enviada.' });
    }

    console.log("1. Fazendo upload da foto para o Cloudinary...");
    // Isso cria um link público rápido para a foto do cliente
    const uploadResult = await cloudinary.uploader.upload(imageBase64, {
      folder: 'ai_pet_uploads',
    });
    const originalImageUrl = uploadResult.secure_url;

    console.log("2. Enviando para o Replicate (O Chef de Cozinha)...");
    
    // Montamos o pedido para a IA. 
    // O 'promptExtra' é o que o cliente escolheu (ex: 'usando uma coleira de couro premium')
    const finalPrompt = `Professional studio photography of a cute pet ${promptExtra}, highly detailed, 4k, soft lighting, premium e-commerce photography`;

    // Chamamos o modelo SDXL Image-to-Image (Stable Diffusion)
    const output = await replicate.run(
      "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b", 
      {
        input: {
          prompt: finalPrompt,
          negative_prompt: "ugly, blurry, deformed, poorly drawn, bad anatomy, human hands, text, watermark, cartoon, animated",
          image: originalImageUrl,
          prompt_strength: 0.65, // 0.65 mantém a estrutura do cachorro, mas altera o estilo para adicionar o produto
          num_outputs: 1,
          scheduler: "K_EULER",
          num_inference_steps: 30
        }
      }
    );

    const generatedImageUrl = output[0]; // A IA devolve a imagem recém-criada

    console.log("3. Salvando a arte final para não expirar...");
    const finalResult = await cloudinary.uploader.upload(generatedImageUrl, {
      folder: 'ai_pet_generated',
    });

    // Devolve para a Shopify!
    return res.status(200).json({ 
      success: true, 
      generatedImage: finalResult.secure_url,
      originalImage: originalImageUrl
    });

  } catch (error) {
    console.error("Erro no processamento da IA:", error);
    return res.status(500).json({ error: 'Erro ao gerar a mágica. Tente novamente.', details: error.message });
  }
}
