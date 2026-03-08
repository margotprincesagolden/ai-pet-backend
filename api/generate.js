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

// ─── ANÁLISE DO PET VIA CLAUDE (rápido, preciso, não compete com Replicate) ───
async function analyzePetWithClaude(imageUrl) {
  // Baixa a imagem e converte para base64 para enviar ao Claude
  const imgRes = await fetch(imageUrl);
  const imgBuffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(imgBuffer).toString('base64');
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // Haiku: ultra rápido e barato para visão
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 },
            },
            {
              type: 'text',
              text: `Analyze this image. Respond ONLY with a JSON object, no extra text:
{
  "is_pet": true or false,
  "animal_type": "dog" or "cat" or "other" or "none",
  "breed": "breed name or mixed breed",
  "size": "tiny" or "small" or "medium" or "large" or "giant",
  "weight_estimate_kg": number,
  "fur_type": "short" or "medium" or "long" or "curly" or "wire",
  "fur_color": "brief color description",
  "pose": "sitting" or "standing" or "lying" or "running" or "other",
  "neck_visible": true or false,
  "head_top_visible": true or false,
  "face_visible": true or false
}

Size guide: tiny=under 3kg (Chihuahua), small=3-10kg (Poodle/Shih Tzu), medium=10-25kg (Beagle/Bulldog), large=25-45kg (Labrador/Golden), giant=over 45kg (Great Dane/São Bernardo).`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude vision error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─── DICIONÁRIO DE PEÇAS — INTELIGENTE POR TAMANHO ───────────────────────────
function buildAccessoryInstructions(productTitle, promptExtra, petAnalysis) {
  const t = productTitle.toLowerCase();
  const size = petAnalysis?.size || 'medium';
  const weightKg = petAnalysis?.weight_estimate_kg || 10;
  const neckVisible = petAnalysis?.neck_visible !== false;
  const headVisible = petAnalysis?.head_top_visible !== false;

  const sizeContext = {
    tiny:   { neck: 'very small and delicate', bandana: '6-8cm wide when tied',  bow: '3-4cm ribbon bow' },
    small:  { neck: 'small',                   bandana: '10-14cm wide when tied', bow: '5-7cm ribbon bow' },
    medium: { neck: 'medium',                  bandana: '16-22cm wide when tied', bow: '8-10cm ribbon bow' },
    large:  { neck: 'large and thick',         bandana: '24-32cm wide when tied', bow: '12-14cm ribbon bow' },
    giant:  { neck: 'very large and thick',    bandana: '35-45cm wide when tied', bow: '16-20cm ribbon bow' },
  };
  const sc = sizeContext[size] || sizeContext.medium;

  if (t.includes('bandana')) {
    return {
      placement: `wearing a bandana tied around the neck`,
      anchorNote: neckVisible
        ? `The bandana knot sits at the center of the chest. Sized for a ${sc.neck} neck — approximately ${sc.bandana}. Fabric drapes naturally forming a triangle pointing down toward the chest.`
        : `Bandana tied around the neck with knot at chest center, visible even through fur.`,
      styleBoost: `Exact fabric texture, print pattern and colors from the second image. Fits snugly — not loose, not tight. Triangle tip reaches mid-chest.`,
      critical: `MUST be sized correctly for a ${size} dog (${weightKg}kg). Not oversized, not undersized.`,
    };
  }

  if (t.includes('laço') || t.includes('laco') || t.includes('bow') || t.includes('presilha') || t.includes('hair')) {
    return {
      placement: `with a decorative bow on top of the head between the ears`,
      anchorNote: headVisible
        ? `Bow centered on top of the skull, between and slightly behind the ears. Size: ${sc.bow}, proportional to the dog's head.`
        : `Bow placed on top of the head between the ears, even if partially hidden by fur.`,
      styleBoost: `Exact ribbon texture, print and colors from the second image. Two symmetrical loops with a center knot. Clipped or tied to the fur — not floating.`,
      critical: `Sized proportionally for a ${size} dog's head. Elegant, not oversized.`,
    };
  }

  if (t.includes('kit') || t.includes('conjunto') || t.includes('set')) {
    return {
      placement: `wearing a complete matching accessory set`,
      anchorNote: `TWO accessories: (1) Bandana around the neck — knot at chest center, ${sc.bandana}, triangle draping down. (2) Matching bow on top of the head — ${sc.bow}, centered between ears. Both use the exact same fabric pattern from the second image.`,
      styleBoost: `Both accessories perfectly coordinated — same print, same fabric, same colors. Each correctly proportioned for a ${size} dog.`,
      critical: `BOTH must be visible and correctly placed. Bandana on neck, bow on head. Sized for ${size} (${weightKg}kg).`,
    };
  }

  if (t.includes('coleira') || t.includes('collar')) {
    return {
      placement: `wearing a collar around the neck`,
      anchorNote: `Collar wraps around the ${sc.neck} neck, flat against the fur. Hardware visible at front or side.`,
      styleBoost: `Exact material, color and hardware from the second image. Fits properly — slight natural sag.`,
      critical: `Must fit a ${size} dog neck. Texture must match the reference exactly.`,
    };
  }

  if (t.includes('guia') || t.includes('lead') || t.includes('leash')) {
    return {
      placement: `with a leash and collar`,
      anchorNote: `Collar and leash visible. Leash attaches at front of collar and drapes naturally. Proportional to ${size} dog.`,
      styleBoost: `Exact leash material, width and color from the second image. Hardware gleaming.`,
      critical: `Correctly sized for a ${size} dog.`,
    };
  }

  return {
    placement: `wearing ${productTitle} as an accessory`,
    anchorNote: `Correctly fitted for a ${size} dog (${weightKg}kg).`,
    styleBoost: promptExtra || 'Accessory well-fitted and prominent.',
    critical: `Reproduce exact colors and textures from the second image.`,
  };
}

function buildFusionPrompt(petAnalysis, accessory) {
  const { breed, size, fur_color, fur_type, pose, animal_type } = petAnalysis;
  const petDesc = `${size} ${breed || animal_type} with ${fur_color || ''} ${fur_type || ''} fur, ${pose || 'sitting'}`;

  return [
    `The subject is a ${petDesc} — keep this animal EXACTLY as it appears in the first image: same face, same markings, same fur color and texture, same body proportions, same pose, same background`,
    `${accessory.placement} from the second image`,
    accessory.anchorNote,
    accessory.styleBoost,
    accessory.critical,
    `Professional pet fashion photography, soft natural lighting, sharp focus on both the animal's face and the accessory, photorealistic, high detail, 8k quality`,
  ].join('. ');
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método não permitido.' });

  try {
    const { imageBase64, productImageBase64, productTitle, promptExtra } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Foto do pet obrigatória.' });

    // ── STEP 1: Upload paralelo para Cloudinary ───────────────────────────────
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

    // ── STEP 2: Analisa o pet com Claude Haiku (rápido, ~1s) ─────────────────
    console.log('STEP 2 → Analisando pet com Claude Haiku...');
    let petAnalysis;
    try {
      petAnalysis = await analyzePetWithClaude(petImageUrl);
      console.log('   Análise:', JSON.stringify(petAnalysis));
    } catch (visionErr) {
      // Se falhar, continua com defaults — não bloqueia a geração
      console.warn('   Visão falhou, usando defaults:', visionErr.message);
      petAnalysis = {
        is_pet: true, animal_type: 'dog', breed: 'mixed breed',
        size: 'medium', weight_estimate_kg: 10, pose: 'sitting',
        neck_visible: true, head_top_visible: true,
        fur_type: 'short', fur_color: 'mixed',
      };
    }

    // ── STEP 3: Valida se é cachorro ou gato ─────────────────────────────────
    if (petAnalysis.is_pet === false || petAnalysis.animal_type === 'none') {
      return res.status(422).json({
        error: 'not_a_pet',
        message: 'Não identificamos um cachorro ou gato na foto. Por favor, envie uma foto clara do seu pet com o rosto visível.',
      });
    }
    if (petAnalysis.animal_type !== 'dog' && petAnalysis.animal_type !== 'cat') {
      return res.status(422).json({
        error: 'unsupported_animal',
        message: `Identificamos um(a) ${petAnalysis.animal_type} na foto. No momento aceitamos apenas cachorros e gatos.`,
      });
    }

    // ── STEP 4: Monta prompt inteligente ─────────────────────────────────────
    console.log('STEP 3 → Montando prompt inteligente...');
    const accessory = buildAccessoryInstructions(productTitle || '', promptExtra || '', petAnalysis);
    const fusionPrompt = buildFusionPrompt(petAnalysis, accessory);
    console.log('   Prompt:', fusionPrompt);

    // ── STEP 5: Dispara job no Replicate ─────────────────────────────────────
    console.log('STEP 4 → Disparando job no Replicate...');
    let predictionId;

    if (productRefUrl) {
      const body = {
        input: {
          input_image_1: petImageUrl,
          input_image_2: productRefUrl,
          prompt: fusionPrompt,
          aspect_ratio: '1:1',
          safety_tolerance: 2,
          output_format: 'jpg',
        },
      };
      console.log('   Payload:', JSON.stringify(body, null, 2));
      const response = await fetch(
        'https://api.replicate.com/v1/models/flux-kontext-apps/multi-image-kontext-pro/predictions',
        {
          method: 'POST',
          headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const responseText = await response.text();
      console.log(`   Replicate ${response.status}:`, responseText);
      if (!response.ok) throw new Error(`Replicate multi-image error ${response.status}: ${responseText}`);
      predictionId = JSON.parse(responseText).id;

    } else {
      const body = {
        input: {
          input_image: petImageUrl,
          prompt: fusionPrompt,
          output_format: 'jpg',
          safety_tolerance: 2,
          aspect_ratio: '1:1',
        },
      };
      const response = await fetch(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions',
        {
          method: 'POST',
          headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const responseText = await response.text();
      if (!response.ok) throw new Error(`Replicate single-image error ${response.status}: ${responseText}`);
      predictionId = JSON.parse(responseText).id;
    }

    console.log(`✅ Job disparado! predictionId: ${predictionId}`);
    return res.status(200).json({ jobId: predictionId, petImageUrl, productRefUrl, petAnalysis });

  } catch (error) {
    console.error('❌ Erro em /api/generate:', error);
    return res.status(500).json({ error: `Generate Error: ${error.message}` });
  }
}
