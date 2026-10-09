#!/usr/bin/env node
/**
 * Comprueba GET /health → stripeModes (tras desplegar el backend).
 * Uso: node scripts/verify-stripe-phase-health.js [url]
 * Default: https://tpv-gestor-backend.onrender.com/health
 */
const url = process.argv[2] || 'https://tpv-gestor-backend.onrender.com/health';

const main = async () => {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || !body.ok) {
    console.error('Health no OK:', res.status, body);
    process.exit(1);
  }
  const modes = body.stripeModes;
  if (!modes || !modes.billing || !modes.connect) {
    console.error('Falta stripeModes en /health. ¿Backend antiguo sin desplegar?', body);
    process.exit(1);
  }
  console.log('commit:', body.commit);
  console.log('stripeModes:', modes);
  if (modes.billing === 'live' && modes.connect === 'test') {
    console.log('Fase 1 en runtime: billing live + Connect test. OK.');
    return;
  }
  if (modes.billing === 'live' && modes.connect === 'live') {
    console.log('Fase 2 en runtime: billing + Connect live. OK.');
    return;
  }
  console.log('Aún no Fase 1/2 en Render. Configura variables live en Environment y redespliega.');
  console.log('Fase 1 objetivo: billing=live, connect=test');
  process.exitCode = 2;
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
