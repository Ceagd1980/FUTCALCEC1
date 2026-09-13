const fs = require('fs');
const path = require('path');
const thresholds = require('../config/thresholds');

const ZONA_HORARIA = 'America/Guayaquil';

function leer(pathRelativo) {
  const p = path.join(__dirname, '..', 'public', 'data', pathRelativo);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fechaEC(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date(iso));
}

function fechaDeManana() {
  const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return fechaEC(manana.toISOString());
}

function promedio(...valores) {
  const validos = valores.filter((v) => v !== null && v !== undefined);
  if (!validos.length) return null;
  return Math.round((validos.reduce((a, b) => a + b, 0) / validos.length) * 10) / 10;
}

/**
 * Fórmula 1X2 pedida, cruzando el registro de LOCAL-EN-CASA con VISITA-FUERA:
 *   Local  = (Wh_local + La_visita) / (GPh_local + GPa_visita)
 *   Empate = (Dh_local + Da_visita) / (GPh_local + GPa_visita)
 *   Visita = (Wa_visita + Lh_local) / (GPh_local + GPa_visita)
 */
function calcular1X2(local, visita) {
  if (!local || !visita) return { probLocal: null, probEmpate: null, probVisita: null };
  const gpHLocal = (local.wh || 0) + (local.dh || 0) + (local.lh || 0);
  const gpAVisita = (visita.wa || 0) + (visita.da || 0) + (visita.la || 0);
  const total = gpHLocal + gpAVisita;
  if (!total) return { probLocal: null, probEmpate: null, probVisita: null };

  const probLocal = Math.round(((local.wh || 0) + (visita.la || 0)) / total * 1000) / 10;
  const probEmpate = Math.round(((local.dh || 0) + (visita.da || 0)) / total * 1000) / 10;
  const probVisita = Math.round(((visita.wa || 0) + (local.lh || 0)) / total * 1000) / 10;
  return { probLocal, probEmpate, probVisita };
}

// % de partidos ganados simple (sobre el total jugado por cada equipo)
function pctGanadorSimple(equipo) {
  if (!equipo || !equipo.gp) return null;
  return Math.round(((equipo.w || 0) / equipo.gp) * 1000) / 10;
}

function analizarPartido(partido, equipos, liga, slug) {
  const claveLocal = normalizar(partido.local);
  const claveVisita = normalizar(partido.visita);
  const local = equipos[claveLocal] || null;
  const visita = equipos[claveVisita] || null;

  const { probLocal, probEmpate, probVisita } = calcular1X2(local, visita);
  const favoritoEsLocal = (probLocal || 0) >= (probVisita || 0);
  const probFavorito = favoritoEsLocal ? probLocal : probVisita;
  const probDebil = favoritoEsLocal ? probVisita : probLocal;

  const overUnderYBtts = {
    over15: promedio(local?.over15, visita?.over15),
    over25: promedio(local?.over25, visita?.over25),
    btts: promedio(local?.btts, visita?.btts),
  };

  const rachaGanadoraLocal = local?.rachaTipo === 'W' && local?.rachaLongitud >= thresholds.minRachaGanadora;
  const rachaGanadoraVisita = visita?.rachaTipo === 'W' && visita?.rachaLongitud >= thresholds.minRachaGanadora;

  const cumple = {
    ganador60: probFavorito !== null && probFavorito >= thresholds.minGanadorFavorito && probDebil !== null && probDebil <= thresholds.maxGanadorDebil,
    ganadorSimple60: false, // se completa abajo
    over15_60: overUnderYBtts.over15 !== null && overUnderYBtts.over15 >= thresholds.minOver15,
    over25_60: overUnderYBtts.over25 !== null && overUnderYBtts.over25 >= thresholds.minOver25,
    btts60: overUnderYBtts.btts !== null && overUnderYBtts.btts >= thresholds.minBTTS,
    rachaGanadora: Boolean(rachaGanadoraLocal || rachaGanadoraVisita),
  };

  const winSimpleLocal = pctGanadorSimple(local);
  const winSimpleVisita = pctGanadorSimple(visita);
  cumple.ganadorSimple60 = (winSimpleLocal >= thresholds.minGanadorFavorito) || (winSimpleVisita >= thresholds.minGanadorFavorito);

  const destacado = cumple.ganador60 || cumple.over15_60 || cumple.over25_60 || cumple.btts60 || cumple.rachaGanadora;

  return {
    liga: liga.nombre,
    region: liga.region,
    ligaSlug: slug,
    equipoLocal: partido.local,
    equipoVisita: partido.visita,
    horaInicio: partido.fechaISO,
    equipoFavorito: favoritoEsLocal ? partido.local : partido.visita,
    probabilidades: {
      ganadorLocal: probLocal,
      empate: probEmpate,
      ganadorVisita: probVisita,
      ganadorSimpleLocal: winSimpleLocal,
      ganadorSimpleVisita: winSimpleVisita,
      btts: overUnderYBtts.btts,
      over15: overUnderYBtts.over15,
      over25: overUnderYBtts.over25,
    },
    rachas: {
      local: local ? `${local.rachaTipo || '-'}${local.rachaLongitud || ''}` : null,
      visita: visita ? `${visita.rachaTipo || '-'}${visita.rachaLongitud || ''}` : null,
    },
    ppg: { local: local?.ppgh ?? null, visita: visita?.ppga ?? null },
    cumple,
    destacado,
  };
}

function main() {
  const soccerstats = leer('soccerstats.json');
  if (!soccerstats) {
    console.error('No existe public/data/soccerstats.json — corre primero fetch-soccerstats.js');
    process.exit(1);
  }

  const objetivo = fechaDeManana();
  console.log(`Filtrando partidos del ${objetivo} (hora Ecuador)...`);

  const partidosAnalizados = [];
  for (const [slug, liga] of Object.entries(soccerstats.ligas)) {
    for (const partido of liga.partidos || []) {
      if (!partido.fechaISO || fechaEC(partido.fechaISO) !== objetivo) continue;
      partidosAnalizados.push(analizarPartido(partido, liga.equipos || {}, liga, slug));
    }
  }

  const resultado = {
    generadoEn: new Date().toISOString(),
    fechaObjetivo: objetivo,
    fuenteDatos: soccerstats.generadoEn,
    totalPartidos: partidosAnalizados.length,
    destacados: partidosAnalizados.filter((p) => p.destacado).length,
    partidos: partidosAnalizados,
  };

  const outPath = path.join(__dirname, '..', 'public', 'data', 'radar.json');
  fs.writeFileSync(outPath, JSON.stringify(resultado, null, 2));
  console.log(`Radar generado: ${resultado.destacados} destacados de ${resultado.totalPartidos} partidos para el ${objetivo}`);
}

main();
