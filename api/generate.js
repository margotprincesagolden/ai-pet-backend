import { v2 as cloudinary } from 'cloudinary';

// Pipeline: Claude Haiku → Grounding DINO (bbox) → SAM2 (máscara) → SDXL Inpainting
// Preserva o pet pixel a pixel — só pinta a região do acessório
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const getMime   = b => (b.match(/^data:(image\/[\w+]+);base64,/) || [])[1] || 'image/jpeg';
const stripB64  = b => b.replace(/^data:image\/\w+;base64,/, '');

// ─── REPLICATE POLLING ───────────────────────────────────────────────────────
async function replicateWait(predictionUrl) {
  let attempts = 0;
  while (attempts++ < 90) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(predictionUrl, {
      headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
    });
    const p = await res.json();
    if (p.status === 'succeeded') return p.output;
    if (p.status === 'failed') throw new Error(`Replicate falhou: ${p.error}`);
  }
  throw new Error('Replicate timeout após 3 minutos');
}

async function replicateRun(modelPath, input) {
  const res = await fetch(
    `https://api.replicate.com/v1/models/${modelPath}/predictions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=60',
      },
      body: JSON.stringify({ input }),
    }
  );
  const p = await res.json();
  if (!res.ok) throw new Error(`Replicate error: ${JSON.stringify(p)}`);
  if (p.status === 'succeeded') return p.output;
  if (p.status === 'failed') throw new Error(`Replicate falhou: ${p.error}`);
  return replicateWait(p.urls.get);
}

async function replicateRunVersion(version, input) {
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    },
    body: JSON.stringify({ version, input }),
  });
  const p = await res.json();
  if (!res.ok) throw new Error(`Replicate error: ${JSON.stringify(p)}`);
  if (p.status === 'succeeded') return p.output;
  if (p.status === 'failed') throw new Error(`Replicate falhou: ${p.error}`);
  return replicateWait(p.urls.get);
}

// ─── STEP 1: CLAUDE HAIKU — analisa o pet ────────────────────────────────────
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
  const raw = data.content?.[0]?.text || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude: JSON inválido');
  return JSON.parse(m[0]);
}

// ─── STEP 2: GROUNDING DINO — bounding box da região do acessório ─────────────
function getAccessoryQuery(title) {
  const t = title.toLowerCase();
  if (t.includes('laço') || t.includes('bow') || t.includes('presilha')) return 'dog head top between ears';
  if (t.includes('kit') || t.includes('conjunto')) return 'dog neck chest and head top';
  if (t.includes('coleira') || t.includes('collar')) return 'dog neck';
  return 'dog neck and chest area';  // bandana default
}

function fallbackBbox(pet, title) {
  const t = title.toLowerCase();
  const isBow = t.includes('laço') || t.includes('bow') || t.includes('presilha');
  const dir = pet?.neck_direction || 'front';
  if (isBow) return { x1: 0.25, y1: 0.05, x2: 0.75, y2: 0.38 };
  const map = { front: [0.20, 0.25, 0.80, 0.62], side: [0.15, 0.20, 0.75, 0.58],
    'three-quarter': [0.15, 0.22, 0.80, 0.60], back: [0.15, 0.15, 0.85, 0.50] };
  const [x1, y1, x2, y2] = map[dir] || map.front;
  return { x1, y1, x2, y2 };
}

async function detectRegion(imageUrl, pet, title) {
  const query = getAccessoryQuery(title);
  console.log(`   DINO query: "${query}"`);
  try {
    const output = await replicateRun('adirik/grounding-dino', {
      image: imageUrl,
      query,
      box_threshold: 0.22,
      text_threshold: 0.22,
    });
    console.log('   DINO output:', JSON.stringify(output)?.substring(0, 200));

    // Parseia diferentes formatos de output do DINO
    let boxes = [];
    if (output?.boxes?.length) boxes = output.boxes;
    else if (Array.isArray(output) && output[0]?.box) boxes = output.map(o => o.box);
    else if (Array.isArray(output) && Array.isArray(output[0])) boxes = output;

    if (!boxes.length) {
      console.warn('   DINO: sem boxes, usando fallback');
      return fallbackBbox(pet, title);
    }

    // Pega o box de maior score (primeiro ou o que cobre mais área)
    const raw = boxes[0];
    let x1, y1, x2, y2;
    if (Array.isArray(raw)) [x1, y1, x2, y2] = raw;
    else if (raw.x1 !== undefined) ({ x1, y1, x2, y2 } = raw);
    else if (raw.xmin !== undefined) { x1 = raw.xmin; y1 = raw.ymin; x2 = raw.xmax; y2 = raw.ymax; }
    else return fallbackBbox(pet, title);

    // Expande 20% para garantir margem ao inpainting
    const pw = x2 - x1, ph = y2 - y1;
    return {
      x1: Math.max(0, x1 - pw * 0.20),
      y1: Math.max(0, y1 - ph * 0.20),
      x2: Math.min(1, x2 + pw * 0.20),
      y2: Math.min(1, y2 + ph * 0.20),
    };
  } catch (e) {
    console.warn('   DINO falhou:', e.message, '— usando fallback');
    return fallbackBbox(pet, title);
  }
}

// ─── STEP 3: SAM2 — máscara precisa pixel a pixel ────────────────────────────
async function generateMask(imageUrl, bbox, W, H) {
  const cx = Math.round(((bbox.x1 + bbox.x2) / 2) * W);
  const cy = Math.round(((bbox.y1 + bbox.y2) / 2) * H);
  // 5 pontos de prompt para cobertura melhor
  const points = [
    [cx, cy],
    [Math.round(bbox.x1 * W + 10), cy],
    [Math.round(bbox.x2 * W - 10), cy],
    [cx, Math.round(bbox.y1 * H + 10)],
    [cx, Math.round(bbox.y2 * H - 10)],
  ].filter(p => p[0] > 0 && p[1] > 0 && p[0] < W && p[1] < H);

  console.log(`   SAM2 pontos:`, points);

  const output = await replicateRun('meta/sam-2', {
    image: imageUrl,
    point_coords: points,
    point_labels: points.map(() => 1),
    multimask_output: false,
  });

  // SAM2 pode retornar array de URLs ou objeto com masks
  let maskUrl;
  if (Array.isArray(output)) maskUrl = output[0];
  else if (output?.masks) maskUrl = output.masks[0];
  else if (typeof output === 'string') maskUrl = output;

  if (!maskUrl) throw new Error('SAM2: sem máscara');
  console.log('   SAM2 máscara:', maskUrl);
  return maskUrl;
}

// ─── STEP 4: Prompt de inpainting ────────────────────────────────────────────
function buildPrompt(title, pet) {
  const t = title.toLowerCase();
  const { fur_color, size, breed, animal_type } = pet;
  const petStr = `${size} ${breed || animal_type} with ${fur_color} fur`;

  const base = `Photorealistic professional pet photography. ${petStr}.`;
  const quality = 'Sharp focus, natural lighting, high detail, 8k quality.';
  const neg = 'deformed, blurry, bad anatomy, distorted, floating, unrealistic, poorly drawn, extra limbs, changed fur color, changed dog face';

  if (t.includes('bandana')) return {
    positive: `${base} Wearing a lilac purple floral lace embroidered bandana tied around the neck. Triangular shape draping toward chest with neat center knot. Delicate flower embroidery on soft lavender cotton lace fabric. Small brown leather logo tag at corner. Natural fabric folds and shadows. ${quality}`,
    negative: neg + ', wrong bandana color, missing knot',
  };
  if (t.includes('laço') || t.includes('bow') || t.includes('presilha')) return {
    positive: `${base} Wearing a lilac purple floral lace bow hair accessory on top of head between ears. Two symmetrical fabric loops with center knot. Securely attached to fur. ${quality}`,
    negative: neg + ', floating bow, wrong placement',
  };
  if (t.includes('kit') || t.includes('conjunto')) return {
    positive: `${base} Wearing matching lilac purple floral lace accessories: bandana tied around neck forming triangle at chest, AND matching bow on top of head between ears. Same fabric and pattern on both. ${quality}`,
    negative: neg + ', missing accessory',
  };
  if (t.includes('coleira') || t.includes('collar')) return {
    positive: `${base} Wearing a fabric collar around the neck. Fits snugly, metal hardware visible at front. ${quality}`,
    negative: neg,
  };
  return {
    positive: `${base} Wearing ${title} as pet accessory. ${quality}`,
    negative: neg,
  };
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Método não permitido.' });

  try {
    const { imageBase64, productImageBase64, productTitle } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Foto do pet obrigatória.' });

    const mime = getMime(imageBase64);
    const b64  = stripB64(imageBase64);

    // STEP 1: Analisa pet
    console.log('STEP 1 → Claude Haiku...');
    let pet;
    try {
      pet = await analyzePet(b64, mime);
      console.log('   Pet:', JSON.stringify(pet));
    } catch (e) {
      console.warn('   Falhou, defaults:', e.message);
      pet = { is_pet: true, animal_type: 'dog', breed: 'mixed breed', size: 'medium',
        weight_kg: 10, fur_color: 'golden', fur_type: 'medium', pose: 'sitting',
        neck_visible: true, neck_direction: 'front', head_top_visible: true,
        lighting: 'soft', background: 'outdoors' };
    }

    if (!pet.is_pet || pet.animal_type === 'none') return res.status(422).json({
      error: 'not_a_pet',
      message: 'Não identificamos um cachorro ou gato. Envie uma foto clara do seu pet.',
    });
    if (pet.animal_type !== 'dog' && pet.animal_type !== 'cat') return res.status(422).json({
      error: 'unsupported_animal',
      message: `Identificamos um(a) ${pet.animal_type}. No momento aceitamos apenas cachorros e gatos.`,
    });

    // STEP 2: Upload pet → Cloudinary
    console.log('STEP 2 → Upload pet...');
    const petUp = await cloudinary.uploader.upload(imageBase64, {
      folder: 'mm_pet_uploads',
      transformation: [{ width: 1024, height: 1024, crop: 'limit' }, { quality: 'auto:best' }],
    });
    const petUrl = petUp.secure_url;
    const W = petUp.width, H = petUp.height;
    console.log(`   ${petUrl} (${W}x${H})`);

    // STEP 3: Grounding DINO → bbox
    console.log('STEP 3 → Grounding DINO...');
    const bbox = await detectRegion(petUrl, pet, productTitle || '');
    console.log('   Bbox:', JSON.stringify(bbox));

    // STEP 4: SAM2 → máscara precisa
    console.log('STEP 4 → SAM2...');
    let maskUrl;
    try {
      maskUrl = await generateMask(petUrl, bbox, W, H);
    } catch (e) {
      // Fallback: máscara retangular via Cloudinary canvas
      console.warn('   SAM2 falhou, usando retângulo:', e.message);
      const x = Math.round(bbox.x1 * W);
      const y = Math.round(bbox.y1 * H);
      const w = Math.round((bbox.x2 - bbox.x1) * W);
      const h = Math.round((bbox.y2 - bbox.y1) * H);
      // Gera PNG de máscara: preto com retângulo branco na região
      const maskUp = await cloudinary.uploader.upload(
        `data:image/svg+xml;base64,${Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
            <rect width="${W}" height="${H}" fill="black"/>
            <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>
          </svg>`
        ).toString('base64')}`,
        { folder: 'mm_masks', format: 'png' }
      );
      maskUrl = maskUp.secure_url;
    }

    // STEP 5: Inpainting com SDXL
    // SDXL: branco na máscara = área redesenhada, preto = preservado
    console.log('STEP 5 → SDXL Inpainting...');
    const { positive, negative } = buildPrompt(productTitle || '', pet);
    console.log('   Prompt:', positive.substring(0, 120) + '...');

    const inpaintOut = await replicateRunVersion(
      // stability-ai/sdxl versão mais recente com suporte a inpainting
      '39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
      {
        image: petUrl,
        mask: maskUrl,
        prompt: positive,
        negative_prompt: negative,
        prompt_strength: 0.85,    // quanto a área mascarada é alterada (0.8-0.9 ideal)
        num_inference_steps: 40,
        guidance_scale: 8.5,
        width: W,
        height: H,
        seed: Math.floor(Math.random() * 999999),
      }
    );

    const generatedUrl = Array.isArray(inpaintOut) ? inpaintOut[0] : inpaintOut;
    if (!generatedUrl) throw new Error('Inpainting não retornou imagem.');

    // STEP 6: Salva no Cloudinary
    console.log('STEP 6 → Salvando resultado...');
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
      debug: { bbox, maskUrl },
    });

  } catch (err) {
    console.error('❌ generate:', err);
    return res.status(500).json({ error: `Generate Error: ${err.message}` });
  }
}
