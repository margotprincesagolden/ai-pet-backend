import { v2 as cloudinary } from 'cloudinary';

// ============================================================
//  /api/status?id=PREDICTION_ID
//  Consultado pelo frontend a cada 2s durante o loading.
//  Retorna: { status: 'processing' | 'succeeded' | 'failed', imageUrl? }
// ============================================================

export const maxDuration = 10;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Método não permitido.' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Parâmetro ?id= obrigatório.' });
  }

  try {
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
    });

    if (!pollRes.ok) {
      const err = await pollRes.text();
      throw new Error(`Replicate poll error ${pollRes.status}: ${err}`);
    }

    const prediction = await pollRes.json();
    console.log(`[Status] id=${id} status=${prediction.status}`);

    if (prediction.status === 'starting' || prediction.status === 'processing') {
      return res.status(200).json({ status: 'processing' });
    }

    if (prediction.status === 'failed') {
      return res.status(200).json({ status: 'failed', error: prediction.error || 'A IA não conseguiu gerar a imagem.' });
    }

    if (prediction.status === 'succeeded') {
      const rawOutput = prediction.output;
      const generatedUrl = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput;

      if (!generatedUrl) {
        return res.status(200).json({ status: 'failed', error: 'Output vazio do Replicate.' });
      }

      console.log(`[Status] Salvando no Cloudinary...`);
      const saved = await cloudinary.uploader.upload(generatedUrl, {
        folder: 'mm_generated_results',
        transformation: [{ width: 1200, height: 1200, crop: 'limit' }, { quality: 'auto:best', fetch_format: 'auto' }],
      });

      console.log(`✅ Salvo: ${saved.secure_url}`);
      return res.status(200).json({ status: 'succeeded', imageUrl: saved.secure_url });
    }

    return res.status(200).json({ status: 'failed', error: `Status inesperado: ${prediction.status}` });

  } catch (error) {
    console.error('❌ Erro em /api/status:', error);
    return res.status(500).json({ error: `Status Error: ${error.message}` });
  }
}
