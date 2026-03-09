// /api/status — Endpoint de compatibilidade
// Com GPT-image-1, a geração é síncrona — generate.js já retorna { status: 'succeeded', imageUrl }
// Este arquivo existe apenas como fallback caso o frontend ainda tente fazer polling.

export const maxDuration = 10;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ message: 'Método não permitido.' });

  // Com GPT-image-1 não há polling — generate.js retorna a imagem direto.
  // Se o frontend chamar /api/status, retorna 'processing' para não quebrar.
  return res.status(200).json({
    status: 'processing',
    message: 'GPT-image-1 é síncrono — a resposta vem diretamente do /api/generate.',
  });
}
