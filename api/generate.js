import { v2 as cloudinary } from 'cloudinary';

export const maxDuration = 30;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function buildPlacementContext(productTitle) {
  const t = productTitle.toLowerCase();
  const placements = [
    { keywords: ['bandana'], placement: 'wearing a bandana tied around the neck', styleBoost: 'fabric texture clearly visible, knot centered on chest' },
    { keywords: ['coleira', 'collar'], placement: 'wearing a collar around the neck', styleBoost: 'collar fit snugly, hardware and texture sharp' },
    { keywords: ['guia', 'lead', 'leash'], placement: 'with a leash attached to collar', styleBoost: 'hardware gleaming, leash draping naturally' },
    { keywords: ['laço', 'laco', 'bow', 'presilha', 'hair', 'topknot'], placement: 'with a bow placed on top of the head between the ears', styleBoost: 'bow centered between ears, ribbon symmetrical' },
    { keywords: ['kit', 'conjunto', 'set'], placement: 'wearing a matching set: bandana around the neck and bow on top of the head', styleBoost: 'both pieces visible, same fabric pattern connecting them' },
    { keywords: ['mochila', 'bag', 'backpack'], placement: 'wearing a small pet backpack on the back', styleBoost: 'backpack properly fitted, straps symmetrical' },
  ];
  for (const entry of placements) {
    if (entry.keywords.some((k) => t.includes(k))) return entry;
  }
  return { placement: `wearing ${productTitle} as an accessory`, styleBoost: 'accessory well-fitted and prominent' };
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método não permitido.' });

  try {
    const { imageBase64, productImageBase64, productTitle, promptExtra } = req.body;

    if (!imageBase64) return res.status(400).json({ error: 'Foto do pet obrigatória.' });

    // ── Upload paralelo para Cloudinary ──────────────────────────────────────
    console.log('STEP 1 → Upload para Cloudinary...');
    const [petUpload, prodUpload] = await Promise.all([
      cloudinary.uploader.upload(imageBase64, {
        folder: 'mm_pet_uploads',
        transformation: [{ width: 1024, height: 1024, crop: 'limit' }, { quality: 'auto:best' }],
      }),
      productImageBase64
        ? cloudinary.uploader.upload(productImageBase64, { folder: 'mm_product_refs' })
        : Promise.resolve(null),
    ]);

    const petImageUrl = petUpload.secure_url;
    const productRefUrl = prodUpload?.secure_url || null;
    console.log('   Pet URL:', petImageUrl);
    console.log('   Produto URL:', productRefUrl);

    // ── Monta prompt ─────────────────────────────────────────────────────────
    const ctx = buildPlacementContext(productTitle || '');
    const productDetails = promptExtra || productTitle || 'accessory';

    const fusionPrompt = [
      `Keep the dog from the first image exactly as it is — same breed, fur, face, expression and pose`,
      `Take the accessory from the second image and place it on the dog: ${ctx.placement}`,
      `Reproduce the exact colors, fabric, pattern and texture of the accessory from the second image`,
      ctx.styleBoost,
      `Professional pet fashion photography, soft studio lighting, sharp focus on face and accessory, photorealistic, 8k quality`,
    ].join('. ');

    // ── Dispara job no Replicate ──────────────────────────────────────────────
    console.log('STEP 2 → Disparando job no Replicate...');
    let predictionId;

    if (productRefUrl) {
      // Multi-image: pet + produto
      // NOTA: este modelo aceita apenas "jpg" ou "png" como output_format
      const body = {
        input: {
          image_1: petImageUrl,
          image_2: productRefUrl,
          prompt: fusionPrompt,
          aspect_ratio: '1:1',
          safety_tolerance: 2,
          output_format: 'jpg',   // webp não é suportado neste modelo
        },
      };

      console.log('   Payload multi-image:', JSON.stringify(body, null, 2));

      const response = await fetch(
        'https://api.replicate.com/v1/models/flux-kontext-apps/multi-image-kontext-pro/predictions',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      const responseText = await response.text();
      console.log(`   Replicate response ${response.status}:`, responseText);

      if (!response.ok) {
        throw new Error(`Replicate multi-image error ${response.status}: ${responseText}`);
      }

      const prediction = JSON.parse(responseText);
      predictionId = prediction.id;

    } else {
      // Fallback single-image
      const fallbackPrompt = [
        `Add ${ctx.placement} to the dog in this photo`,
        `The accessory: ${productDetails}`,
        ctx.styleBoost,
        `Keep the dog's appearance exactly the same`,
        `Professional pet photography, photorealistic`,
      ].join('. ');

      const body = {
        input: {
          input_image: petImageUrl,
          prompt: fallbackPrompt,
          output_format: 'jpg',
          output_quality: 92,
          safety_tolerance: 2,
          aspect_ratio: '1:1',
        },
      };

      const response = await fetch(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      const responseText = await response.text();
      console.log(`   Replicate fallback response ${response.status}:`, responseText);

      if (!response.ok) {
        throw new Error(`Replicate single-image error ${response.status}: ${responseText}`);
      }

      const prediction = JSON.parse(responseText);
      predictionId = prediction.id;
    }

    console.log(`✅ Job disparado! predictionId: ${predictionId}`);
    return res.status(200).json({ jobId: predictionId, petImageUrl, productRefUrl });

  } catch (error) {
    console.error('❌ Erro em /api/generate:', error);
    return res.status(500).json({ error: `Generate Error: ${error.message}` });
  }
}
