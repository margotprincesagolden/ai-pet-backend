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

// ─── ANÁLISE VISUAL DO PET VIA LLaVA ─────────────────────────────────────────
// Retorna: { isAnimal, breed, size, sizeLabel, furType, pose }
async function analyzePet(imageUrl) {
  const response = await fetch(
    'https://api.replicate.com/v1/models/yorickvp/llava-13b/predictions',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 'b5f621affc37f12539a441e3c11396a31173bb23f79ef9ae521714fc2ee81a26',
        input: {
          image: imageUrl,
          prompt: `Analyze this image and respond in JSON only, no extra text. Use this exact format:
{
  "is_pet": true or false,
  "animal_type": "dog" or "cat" or "other" or "none",
  "breed": "breed name or mixed",
  "size": "tiny" or "small" or "medium" or "large" or "giant",
  "weight_estimate_kg": number,
  "fur_type": "short" or "medium" or "long" or "curly" or "wire",
  "fur_color": "description",
  "pose": "sitting" or "standing" or "lying" or "running" or "other",
  "neck_visible": true or false,
  "head_top_visible": true or false,
  "face_visible": true or false
}

Size guide: tiny=under 3kg (Chihuahua), small=3-10kg (Poodle), medium=10-25kg (Beagle), large=25-45kg (Labrador), giant=over 45kg (Great Dane).`,
          max_tokens: 200,
          temperature: 0.1,
        },
      }),
    }
  );

  if (!response.ok) throw new Error('LLaVA vision request failed');

  let prediction = await response.json();
  const predId = prediction.id;

  // Poll até terminar
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
    });
    prediction = await poll.json();
    if (prediction.status === 'succeeded' || prediction.status === 'failed') break;
  }

  if (prediction.status !== 'succeeded') throw new Error('Vision analysis failed');

  const raw = Array.isArray(prediction.output) ? prediction.output.join('') : prediction.output;

  // Extrai JSON da resposta (LLaVA às vezes adiciona texto antes/depois)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse vision output');

  return JSON.parse(jsonMatch[0]);
}

// ─── DICIONÁRIO DE PEÇAS — INTELIGENTE POR TAMANHO ───────────────────────────
// Cada peça sabe onde fica, como escala com o tamanho, e o que é crítico mostrar
function buildAccessoryInstructions(productTitle, promptExtra, petAnalysis) {
  const t = productTitle.toLowerCase();
  const size = petAnalysis?.size || 'medium';
  const weightKg = petAnalysis?.weight_estimate_kg || 10;
  const neckVisible = petAnalysis?.neck_visible !== false;
  const headVisible = petAnalysis?.head_top_visible !== false;

  // Mapa de tamanho → instruções de escala
  const sizeContext = {
    tiny:   { neck: 'very small, delicate', bandana: '6-8cm wide when tied', bow: '3-4cm ribbon bow' },
    small:  { neck: 'small',                bandana: '10-14cm wide when tied', bow: '5-7cm ribbon bow' },
    medium: { neck: 'medium',               bandana: '16-22cm wide when tied', bow: '8-10cm ribbon bow' },
    large:  { neck: 'large, thick',         bandana: '24-32cm wide when tied', bow: '12-14cm ribbon bow' },
    giant:  { neck: 'very large, thick',    bandana: '35-45cm wide when tied', bow: '16-20cm ribbon bow' },
  };

  const sc = sizeContext[size] || sizeContext.medium;

  // ── Bandana ──────────────────────────────────────────────────────────────────
  if (t.includes('bandana')) {
    return {
      placement: `wearing a bandana tied around the neck`,
      anchorNote: neckVisible
        ? `The bandana knot sits at the center of the chest. The bandana is proportional to the dog's ${sc.neck} neck — approximately ${sc.bandana}. The fabric drapes naturally forming a triangle pointing down toward the chest.`
        : `A bandana is tied around the neck, visible even if neck is partially hidden by fur. Knot at chest center.`,
      styleBoost: `Exact fabric texture, print pattern and colors from the second image. The bandana fits snugly — not too loose, not too tight. Triangle tip reaches mid-chest.`,
      critical: `The bandana MUST be sized correctly for a ${size} dog (${weightKg}kg). Do NOT make it oversized or undersized.`,
    };
  }

  // ── Laço / Bow / Presilha ────────────────────────────────────────────────────
  if (t.includes('laço') || t.includes('laco') || t.includes('bow') || t.includes('presilha') || t.includes('hair')) {
    return {
      placement: `with a decorative bow hair accessory on top of the head between the ears`,
      anchorNote: headVisible
        ? `The bow sits centered on top of the skull, between and slightly behind the ears. It is ${sc.bow} in size, proportional to the dog's head.`
        : `Place a bow on top of the head area, centered between the ears, even if partially obscured.`,
      styleBoost: `Exact ribbon texture, print and colors from the second image. The bow has two symmetrical loops and a center knot. It is clipped or tied to the fur — not floating.`,
      critical: `Size the bow proportionally to a ${size} dog's head. It should look elegant, not oversized.`,
    };
  }

  // ── Kit (bandana + laço) ─────────────────────────────────────────────────────
  if (t.includes('kit') || t.includes('conjunto') || t.includes('set')) {
    return {
      placement: `wearing a complete matching accessory set`,
      anchorNote: `TWO accessories from the second image: (1) A bandana tied around the neck — knot at chest center, ${sc.bandana}, triangle draping down. (2) A matching bow on top of the head between the ears — ${sc.bow}, centered and clipped to fur. Both pieces use the exact same fabric pattern.`,
      styleBoost: `Both accessories are perfectly coordinated — same print, same fabric, same colors as shown in the second image. Each is correctly proportioned for a ${size} dog.`,
      critical: `BOTH accessories must be visible and correctly placed. Bandana on neck, bow on head. Sized for a ${size} (${weightKg}kg) dog.`,
    };
  }

  // ── Coleira / Collar ──────────────────────────────────────────────────────────
  if (t.includes('coleira') || t.includes('collar')) {
    return {
      placement: `wearing a collar around the neck`,
      anchorNote: `The collar wraps around the ${sc.neck} neck, sitting flat against the fur. Hardware (buckle/tag) visible at front or side. Width proportional to the neck size.`,
      styleBoost: `Exact material, color, hardware and texture from the second image. Collar fits properly — not too tight, slight natural sag.`,
      critical: `Collar must fit a ${size} dog neck correctly. Leather/fabric texture must match the reference image exactly.`,
    };
  }

  // ── Guia / Leash ─────────────────────────────────────────────────────────────
  if (t.includes('guia') || t.includes('lead') || t.includes('leash')) {
    return {
      placement: `with a leash attached to the collar`,
      anchorNote: `Collar and leash system visible. Leash attaches at front of collar and drapes naturally. Proportional to ${size} dog.`,
      styleBoost: `Exact leash material, width and color from the second image. Hardware gleaming. Natural drape.`,
      critical: `Both collar and leash must be correctly sized for a ${size} dog.`,
    };
  }

  // ── Fallback genérico ─────────────────────────────────────────────────────────
  return {
    placement: `wearing ${productTitle} as an accessory`,
    anchorNote: `The accessory is correctly fitted for a ${size} dog (${weightKg}kg). It is proportional and properly placed.`,
    styleBoost: promptExtra || 'Accessory well-fitted and prominent.',
    critical: `Reproduce exact colors and textures from the second image.`,
  };
}

// ─── MONTA PROMPT FINAL DE FUSÃO ─────────────────────────────────────────────
function buildFusionPrompt(petAnalysis, accessory) {
  const { breed, size, fur_color, fur_type, pose, animal_type } = petAnalysis;

  const petDesc = `${size} ${breed || animal_type} with ${fur_color || ''} ${fur_type || ''} fur, ${pose || 'sitting'}`;

  return [
    // Preservação absoluta do animal
    `The subject is a ${petDesc} — keep this animal EXACTLY as it appears in the first image: same face, same markings, same fur color and texture, same body proportions, same pose, same background`,
    // O que adicionar
    `${accessory.placement} from the second image`,
    // Como ancorar e dimensionar
    accessory.anchorNote,
    // Qualidade do produto
    accessory.styleBoost,
    // Crítico de tamanho
    accessory.critical,
    // Qualidade fotográfica
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

    // ── STEP 2: Analisa o pet com visão ──────────────────────────────────────
    console.log('STEP 2 → Analisando pet com LLaVA...');
    let petAnalysis;
    try {
      petAnalysis = await analyzePet(petImageUrl);
      console.log('   Análise:', JSON.stringify(petAnalysis));
    } catch (visionErr) {
      console.warn('   Visão falhou, usando defaults:', visionErr.message);
      petAnalysis = { is_pet: true, animal_type: 'dog', size: 'medium', weight_estimate_kg: 10, pose: 'sitting', neck_visible: true, head_top_visible: true };
    }

    // ── STEP 3: Valida se é um animal aceito ─────────────────────────────────
    if (petAnalysis.is_pet === false || petAnalysis.animal_type === 'none') {
      return res.status(422).json({
        error: 'not_a_pet',
        message: 'Não identificamos um cachorro ou gato na foto. Por favor, envie uma foto clara do seu pet.',
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
      const fallbackPrompt = buildFusionPrompt(petAnalysis, accessory).replace('from the second image', '');
      const body = {
        input: {
          input_image: petImageUrl,
          prompt: fallbackPrompt,
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
    return res.status(200).json({
      jobId: predictionId,
      petImageUrl,
      productRefUrl,
      petAnalysis, // retorna para o frontend poder mostrar info de debug se precisar
    });

  } catch (error) {
    console.error('❌ Erro em /api/generate:', error);
    return res.status(500).json({ error: `Generate Error: ${error.message}` });
  }
}
