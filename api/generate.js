import { v2 as cloudinary } from 'cloudinary';

// GPT-image-1 pode levar até 120s — Vercel Pro suporta até 300s
// No plano Free o limite é 60s. Se der timeout, considere upgrade para Pro.
export const maxDuration = 120;

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

// ─── ANÁLISE DO PET VIA CLAUDE HAIKU ─────────────────────────────────────────
async function analyzePetWithClaude(imageBase64, mimeType) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: imageBase64 },
          },
          {
            type: 'text',
            text: `Analyze this image carefully. Respond ONLY with a JSON object, no extra text:
{
  "is_pet": true or false,
  "animal_type": "dog" or "cat" or "other" or "none",
  "breed": "breed name or mixed breed",
  "size": "tiny" or "small" or "medium" or "large" or "giant",
  "weight_estimate_kg": number,
  "fur_type": "short" or "medium" or "long" or "curly" or "wire",
  "fur_color": "brief color description",
  "coat_pattern": "solid" or "spotted" or "striped" or "merle" or "bicolor" or "tricolor",
  "pose": "sitting" or "standing" or "lying" or "running" or "other",
  "neck_visible": true or false,
  "neck_direction": "facing camera" or "side profile" or "three-quarter" or "back",
  "head_top_visible": true or false,
  "face_visible": true or false,
  "lighting": "bright natural" or "indoor soft" or "indoor harsh" or "backlit" or "low light",
  "background": "brief background description"
}

Size guide: tiny=under 3kg (Chihuahua), small=3-10kg (Poodle/Shih Tzu), medium=10-25kg (Beagle/Bulldog), large=25-45kg (Labrador/Golden), giant=over 45kg (Great Dane).`,
          },
        ],
      }],
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

// ─── DICIONÁRIO DE PEÇAS ─────────────────────────────────────────────────────
function buildAccessoryInstructions(productTitle, promptExtra, petAnalysis) {
  const t = productTitle.toLowerCase();
  const size = petAnalysis?.size || 'medium';
  const weightKg = petAnalysis?.weight_estimate_kg || 10;
  const neckVisible = petAnalysis?.neck_visible !== false;
  const headVisible = petAnalysis?.head_top_visible !== false;
  const neckDir = petAnalysis?.neck_direction || 'facing camera';

  const sizeCtx = {
    tiny:   { neck: 'very small and delicate', bandana: '6-8cm wide when tied',  bow: '3-4cm bow' },
    small:  { neck: 'small',                   bandana: '10-14cm wide when tied', bow: '5-7cm bow' },
    medium: { neck: 'medium',                  bandana: '16-22cm wide when tied', bow: '8-10cm bow' },
    large:  { neck: 'large and thick',          bandana: '24-32cm wide when tied', bow: '12-14cm bow' },
    giant:  { neck: 'very large and thick',     bandana: '35-45cm wide when tied', bow: '16-20cm bow' },
  };
  const sc = sizeCtx[size] || sizeCtx.medium;

  if (t.includes('bandana')) {
    return {
      placement: `wearing a bandana (from the second reference image) tied around the neck`,
      spatial: neckVisible
        ? `The bandana wraps naturally around the ${sc.neck} neck. Knot at the front-center of the chest. Fabric forms a downward-pointing triangle toward the chest, approximately ${sc.bandana}. The neck is oriented ${neckDir} — adjust the wrapping perspective so the bandana follows the correct 3D angle.`
        : `Bandana tied snugly around the neck, knot at chest center. Fabric conforming to neck shape.`,
      fidelity: `The bandana must look IDENTICAL to the product in the second image: exact fabric texture, exact print pattern, exact colors, exact tie style. Not a generic bandana — this specific product.`,
      fit: `Correctly sized for a ${size} dog (≈${weightKg}kg). Not oversized. Triangle tip reaches mid-chest.`,
    };
  }

  if (t.includes('laço') || t.includes('laco') || t.includes('bow') || t.includes('presilha') || t.includes('hair')) {
    return {
      placement: `with a decorative bow hair accessory (from the second reference image) on top of the head`,
      spatial: headVisible
        ? `Bow centered on top of the skull, between and slightly behind the ears. ${sc.bow}, proportional to the dog's head size. Attached to the fur — not floating in the air.`
        : `Bow placed on top of the head between the ears.`,
      fidelity: `Bow must look IDENTICAL to the product in the second image: exact ribbon texture, exact print and colors, two symmetrical loops with center knot.`,
      fit: `Proportional to a ${size} dog's head. Elegant and firmly placed.`,
    };
  }

  if (t.includes('kit') || t.includes('conjunto') || t.includes('set')) {
    return {
      placement: `wearing a complete matching accessory kit (from the second reference image)`,
      spatial: `Place TWO accessories simultaneously: (1) Bandana around the neck — knot at chest center, ${sc.bandana}, triangle draping down, perspective matching ${neckDir} view. (2) Matching bow on top of the head — ${sc.bow}, between ears, attached to fur.`,
      fidelity: `Both accessories must look IDENTICAL to the items in the second image. Same print, same fabric, same colors on both pieces. Perfectly coordinated.`,
      fit: `Both correctly sized for a ${size} dog (≈${weightKg}kg). Both clearly visible in the final image.`,
    };
  }

  if (t.includes('coleira') || t.includes('collar')) {
    return {
      placement: `wearing a collar (from the second reference image) around the neck`,
      spatial: `Collar wraps flat against the ${sc.neck} neck fur. Hardware visible at front-center. Adjusted for ${neckDir} perspective.`,
      fidelity: `Collar must look IDENTICAL to the product in the second image: exact material, color, width and hardware.`,
      fit: `Natural fit with slight drape. Proportional to ${size} dog neck.`,
    };
  }

  return {
    placement: `wearing "${productTitle}" as shown in the second reference image`,
    spatial: `Correctly fitted for a ${size} dog (≈${weightKg}kg).`,
    fidelity: promptExtra || 'Match exact colors and textures from the second image.',
    fit: `Well-proportioned and naturally placed.`,
  };
}

// ─── PROMPT PARA GPT-IMAGE-1 ─────────────────────────────────────────────────
// O GPT-image-1 VÊ as duas imagens diretamente — usa sua compreensão visual nativa
// O prompt foca em INSTRUÇÕES DE EDIÇÃO, não em descrever o que já está visível
function buildGPTImagePrompt(petAnalysis, accessory) {
  const { size, breed, animal_type, fur_color, pose, lighting, background } = petAnalysis;
  const petDesc = `${size} ${breed || animal_type}`;

  return [
    `Edit the FIRST image only: show this ${petDesc} ${accessory.placement}.`,
    accessory.spatial,
    accessory.fidelity,
    accessory.fit,
    `CRITICAL — preserve EXACTLY from the first image: the animal's face, eyes, fur color (${fur_color || 'as shown'}), coat markings and pattern, body shape and proportions, pose (${pose || 'as shown'}), the original lighting (${lighting || 'as shown'}), and the background (${background || 'as shown'}). Do NOT alter, redraw or reimagine the animal — only ADD the accessory from the second image.`,
    `Final quality: photorealistic, professional pet fashion photography, sharp focus on both face and accessory, correct shadow casting, lighting consistency.`,
  ].join(' ');
}

// ─── HELPERS BASE64 ───────────────────────────────────────────────────────────
function base64ToBuffer(base64String) {
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

function getMimeType(base64String) {
  const match = base64String.match(/^data:(image\/[\w+]+);base64,/);
  return match ? match[1] : 'image/jpeg';
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método não permitido.' });

  try {
    const { imageBase64, productImageBase64, productTitle, promptExtra } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Foto do pet obrigatória.' });

    const petMimeType = getMimeType(imageBase64);
    const petBase64Clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // ── STEP 1: Analisa o pet com Claude Haiku ────────────────────────────────
    console.log('STEP 1 → Analisando pet com Claude Haiku...');
    let petAnalysis;
    try {
      petAnalysis = await analyzePetWithClaude(petBase64Clean, petMimeType);
      console.log('   Análise:', JSON.stringify(petAnalysis));
    } catch (visionErr) {
      console.warn('   Visão falhou, usando defaults:', visionErr.message);
      petAnalysis = {
        is_pet: true, animal_type: 'dog', breed: 'mixed breed',
        size: 'medium', weight_estimate_kg: 10, pose: 'sitting',
        neck_visible: true, neck_direction: 'facing camera',
        head_top_visible: true, face_visible: true,
        fur_type: 'short', fur_color: 'mixed',
        coat_pattern: 'solid', lighting: 'natural', background: 'neutral',
      };
    }

    // ── STEP 2: Valida animal ─────────────────────────────────────────────────
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

    // ── STEP 3: Monta prompt ──────────────────────────────────────────────────
    console.log('STEP 2 → Montando prompt inteligente...');
    const accessory = buildAccessoryInstructions(productTitle || '', promptExtra || '', petAnalysis);
    const prompt = buildGPTImagePrompt(petAnalysis, accessory);
    console.log('   Prompt final:', prompt);

    // ── STEP 4: Chama GPT-image-1 com as duas imagens via FormData ────────────
    // Primeira imagem = pet (maior fidelidade automática pelo modelo)
    // Segunda imagem  = produto (referência visual do acessório)
    console.log('STEP 3 → Chamando GPT-image-1...');

    const petBuffer = base64ToBuffer(imageBase64);
    const petExt = petMimeType.split('/')[1].replace('jpeg', 'jpg');

    const formData = new FormData();

    const petBlob = new Blob([petBuffer], { type: petMimeType });
    formData.append('image[]', petBlob, `pet.${petExt}`);

    if (productImageBase64) {
      const prodMime = getMimeType(productImageBase64);
      const prodBuffer = base64ToBuffer(productImageBase64);
      const prodExt = prodMime.split('/')[1].replace('jpeg', 'jpg');
      const prodBlob = new Blob([prodBuffer], { type: prodMime });
      formData.append('image[]', prodBlob, `product.${prodExt}`);
    }

    formData.append('model', 'gpt-image-1');
    formData.append('prompt', prompt);
    formData.append('size', '1024x1024');
    formData.append('quality', 'high');
    formData.append('n', '1');

    const gptRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        // NÃO definir Content-Type — o fetch configura o boundary do multipart automaticamente
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const gptText = await gptRes.text();
    console.log(`   GPT-image-1 ${gptRes.status}:`, gptText.substring(0, 400));

    if (!gptRes.ok) {
      throw new Error(`GPT-image-1 error ${gptRes.status}: ${gptText}`);
    }

    const gptData = JSON.parse(gptText);
    const imageB64Result = gptData.data?.[0]?.b64_json;

    if (!imageB64Result) {
      throw new Error('GPT-image-1 não retornou imagem b64_json.');
    }

    // ── STEP 5: Salva no Cloudinary ───────────────────────────────────────────
    console.log('STEP 4 → Salvando no Cloudinary...');
    const saved = await cloudinary.uploader.upload(`data:image/png;base64,${imageB64Result}`, {
      folder: 'mm_generated_results',
      transformation: [
        { width: 1200, height: 1200, crop: 'limit' },
        { quality: 'auto:best', fetch_format: 'auto' },
      ],
    });

    console.log('✅ Geração concluída:', saved.secure_url);

    // Retorna status: 'succeeded' direto — sem necessidade de polling
    return res.status(200).json({
      status: 'succeeded',
      imageUrl: saved.secure_url,
      petAnalysis,
    });

  } catch (error) {
    console.error('❌ Erro em /api/generate:', error);
    return res.status(500).json({ error: `Generate Error: ${error.message}` });
  }
}
