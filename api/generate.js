import { v2 as cloudinary } from 'cloudinary';

// Pipeline: Claude Haiku (análise) → Cloudinary (upload) → Nano Banana via fal.ai (edição nativa)
// Nano Banana = Gemini 2.5 Flash Image — compreensão visual nativa, sem negative prompts
export const maxDuration = 120;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const getMime  = b => (b.match(/^data:(image\/[\w+]+);base64,/) || [])[1] || 'image/jpeg';
const stripB64 = b => b.replace(/^data:image\/\w+;base64,/, '');

// ─── CLAUDE HAIKU — analisa o pet ────────────────────────────────────────────
async function analyzePet(b64, mime) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: `Analyze this image. Respond ONLY with JSON:
{
  "is_pet": true/false,
  "animal_type": "dog" or "cat" or "other" or "none",
  "breed": "breed or mixed",
  "size": "tiny" or "small" or "medium" or "large" or "giant",
  "weight_kg": number,
  "fur_color": "color description",
  "fur_type": "short" or "medium" or "long" or "curly",
  "pose": "sitting" or "standing" or "lying" or "running" or "other",
  "neck_visible": true/false,
  "neck_direction": "front" or "side" or "three-quarter" or "back",
  "head_top_visible": true/false,
  "lighting": "bright" or "soft" or "dim",
  "background": "brief description"
}
Size: tiny<3kg, small 3-10kg, medium 10-25kg, large 25-45kg, giant>45kg` },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw  = data.content?.[0]?.text || '';
  const m    = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude: JSON inválido');
  return JSON.parse(m[0]);
}

// ─── PROMPT INTELIGENTE POR TIPO DE ACESSÓRIO ────────────────────────────────
// O Nano Banana entende visualmente as duas imagens — o prompt é instrução de edição
// Não precisamos descrever o pet (ele já vê) nem o produto (ele já vê)
// Só precisamos dizer O QUE fazer, ONDE colocar e como PRESERVAR
function buildPrompt(productTitle, pet) {
  const t = productTitle.toLowerCase();
  const { size, breed, animal_type, fur_color, pose, neck_direction, neck_visible, head_top_visible } = pet;
  const petDesc = `${size || 'medium'} ${breed || animal_type || 'dog'} with ${fur_color || 'mixed'} fur`;
  const neckCtx = neck_direction === 'side' ? 'side profile' : neck_direction === 'three-quarter' ? 'three-quarter angle' : 'front-facing';

  // Base: preservação total do pet
  const preserve = `Do NOT change anything about the dog: same face, same fur color and texture, same body markings, same pose (${pose}), same background, same lighting. Only ADD the accessory from the second image.`;

  if (t.includes('bandana')) {
    const neckTip = neck_visible
      ? `The dog's neck is ${neckCtx} — wrap the bandana naturally around the neck following this exact angle.`
      : `Place the bandana around the neck area, conforming to the fur.`;
    return `Place the bandana from the second image on this dog's neck. ${neckTip} The bandana should form a natural triangle draping toward the chest, with the knot tied at the center-front. Reproduce the exact fabric texture, embroidery pattern, color and leather tag from the second image. The bandana must look physically real — natural folds, shadows consistent with the existing lighting. ${preserve}`;
  }

  if (t.includes('laço') || t.includes('laco') || t.includes('bow') || t.includes('presilha')) {
    const headTip = head_top_visible
      ? `Place it centered on top of the skull, between and slightly behind the ears.`
      : `Place it on the head between the ears, even if partially hidden by fur.`;
    return `Place the bow/hair accessory from the second image on this dog's head. ${headTip} Reproduce the exact fabric, ribbon loops, center knot, color and texture from the second image. The accessory must be physically attached to the fur — not floating. Natural shadows consistent with existing lighting. ${preserve}`;
  }

  if (t.includes('kit') || t.includes('conjunto') || t.includes('set')) {
    return `Place BOTH accessories from the second image on this dog simultaneously: (1) the bandana tied around the neck — knot at chest-front, triangle draping down, following the ${neckCtx} perspective; (2) the matching bow on top of the head between the ears. Both accessories must use the exact fabric, pattern and colors from the second image. Natural folds, real shadows, physically plausible placement. ${preserve}`;
  }

  if (t.includes('coleira') || t.includes('collar')) {
    return `Place the collar from the second image around this dog's neck. Follow the ${neckCtx} perspective. Reproduce exact material, color, width and hardware from the second image. Collar fits snugly with natural drape. ${preserve}`;
  }

  return `Add the accessory from the second image to this dog in a natural, realistic way. Reproduce exact colors and materials from the second image. ${preserve}`;
}

// ─── FAL.AI POLLING ──────────────────────────────────────────────────────────
async function falWait(requestId, modelPath) {
  let attempts = 0;
  while (attempts++ < 90) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(
      `https://queue.fal.run/${modelPath}/requests/${requestId}/status`,
      { headers: { Authorization: `Key ${process.env.FAL_API_KEY}` } }
    );
    const data = await res.json();
    console.log(`   fal status [${attempts}]: ${data.status}`);
    if (data.status === 'COMPLETED') {
      const resultRes = await fetch(
        `https://queue.fal.run/${modelPath}/requests/${requestId}`,
        { headers: { Authorization: `Key ${process.env.FAL_API_KEY}` } }
      );
      return await resultRes.json();
    }
    if (data.status === 'FAILED') throw new Error(`fal.ai falhou: ${JSON.stringify(data)}`);
  }
  throw new Error('fal.ai timeout após 4 minutos');
}

async function runNanoBanana(imageUrls, prompt) {
  // Submete job na fila do fal.ai
  const submitRes = await fetch('https://queue.fal.run/fal-ai/nano-banana-pro/edit', {
    method: 'POST',
    headers: {
      Authorization: `Key ${process.env.FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_urls: imageUrls,  // [petUrl, productUrl]
      prompt,
    }),
  });

  const submitData = await submitRes.json();
  if (!submitRes.ok) throw new Error(`fal.ai submit error: ${JSON.stringify(submitData)}`);
  console.log(`   fal.ai job submetido: ${submitData.request_id}`);

  // Se já completou síncronamente
  if (submitData.images?.[0]?.url) return submitData;

  // Polling até completar
  return falWait(submitData.request_id, 'fal-ai/nano-banana-pro/edit');
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método não permitido.' });

  try {
    const { imageBase64, productImageBase64, productTitle } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Foto do pet obrigatória.' });

    const mime = getMime(imageBase64);
    const b64  = stripB64(imageBase64);

    // STEP 1: Claude Haiku analisa o pet
    console.log('STEP 1 → Claude Haiku analisando pet...');
    let pet;
    try {
      pet = await analyzePet(b64, mime);
      console.log('   Pet:', JSON.stringify(pet));
    } catch (e) {
      console.warn('   Análise falhou, usando defaults:', e.message);
      pet = {
        is_pet: true, animal_type: 'dog', breed: 'mixed breed', size: 'medium',
        weight_kg: 10, fur_color: 'golden', fur_type: 'medium', pose: 'sitting',
        neck_visible: true, neck_direction: 'front', head_top_visible: true,
        lighting: 'soft', background: 'outdoors',
      };
    }

    // Valida animal
    if (!pet.is_pet || pet.animal_type === 'none') {
      return res.status(422).json({
        error: 'not_a_pet',
        message: 'Não identificamos um cachorro ou gato. Envie uma foto clara do seu pet.',
      });
    }
    if (pet.animal_type !== 'dog' && pet.animal_type !== 'cat') {
      return res.status(422).json({
        error: 'unsupported_animal',
        message: `Identificamos um(a) ${pet.animal_type}. No momento aceitamos apenas cachorros e gatos.`,
      });
    }

    // STEP 2: Upload ambas as imagens para Cloudinary em paralelo
    // Nano Banana precisa de URLs públicas — não aceita base64 direto
    console.log('STEP 2 → Upload para Cloudinary...');
    const uploads = [
      cloudinary.uploader.upload(imageBase64, {
        folder: 'mm_pet_uploads',
        transformation: [{ width: 1024, height: 1024, crop: 'limit' }, { quality: 'auto:best' }],
      }),
    ];
    if (productImageBase64) {
      uploads.push(
        cloudinary.uploader.upload(productImageBase64, {
          folder: 'mm_product_refs',
          transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto:best' }],
        })
      );
    }
    const [petUp, prodUp] = await Promise.all(uploads);
    const petUrl  = petUp.secure_url;
    const prodUrl = prodUp?.secure_url || null;
    console.log(`   Pet: ${petUrl}`);
    console.log(`   Produto: ${prodUrl}`);

    // STEP 3: Monta prompt contextualizado pelo Claude
    console.log('STEP 3 → Montando prompt...');
    const prompt = buildPrompt(productTitle || '', pet);
    console.log('   Prompt:', prompt.substring(0, 150) + '...');

    // STEP 4: Nano Banana — edição visual nativa com as duas imagens
    // Primeira URL = pet (referência principal), Segunda = produto (referência do acessório)
    console.log('STEP 4 → Nano Banana (fal.ai) gerando...');
    const imageUrls = prodUrl ? [petUrl, prodUrl] : [petUrl];
    const falResult = await runNanoBanana(imageUrls, prompt);

    const generatedUrl = falResult.images?.[0]?.url;
    if (!generatedUrl) throw new Error('Nano Banana não retornou imagem.');
    console.log('   Gerado:', generatedUrl);

    // STEP 5: Salva resultado no Cloudinary
    console.log('STEP 5 → Salvando no Cloudinary...');
    const saved = await cloudinary.uploader.upload(generatedUrl, {
      folder: 'mm_generated_results',
      transformation: [
        { width: 1200, height: 1200, crop: 'limit' },
        { quality: 'auto:best', fetch_format: 'auto' },
      ],
    });

    console.log('✅ Pronto:', saved.secure_url);
    return res.status(200).json({
      status: 'succeeded',
      imageUrl: saved.secure_url,
      petAnalysis: pet,
    });

  } catch (err) {
    console.error('❌ generate:', err);
    return res.status(500).json({ error: `Generate Error: ${err.message}` });
  }
}
