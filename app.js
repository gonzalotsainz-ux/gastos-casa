// ========== Gastos Casa — gestor de finanzas en pareja ==========

// Configuración fija de la app: las dos casas preconfiguradas.
// La Master Key y los Bin IDs se rellenan aquí y la app las usa sin pedir al usuario.
const APP_CONFIG = {
  masterKey: "$2a$10$ySq5tRBeUtQjNtOKtZb9oeISlp5gwoALA1qPytOt7cOmxVUeAY/nK",
  hogares: [
    {
      key: "ali-gon",
      nombre: "Casa ALI y GON",
      binId: "6a0b7889ee5a733b12deb8af",
      miembros: ["ALI", "GON"],
      color: "#7a4ec5",
    },
    {
      key: "luisa-vicente",
      nombre: "Casa LUISA y VICENTE",
      binId: "6a0b79df6610dd3ae86801ec",
      miembros: ["LUISA", "VICENTE"],
      color: "#2a8a5b",
    },
  ],
};
function appConfigOK() {
  return APP_CONFIG.masterKey && !APP_CONFIG.masterKey.startsWith("PENDIENTE")
    && APP_CONFIG.hogares.every((h) => h.binId && !h.binId.startsWith("PENDIENTE"));
}

const STORAGE_KEY = "gastos-casa-v1";
const SESSION_KEY = "gc-session";
const HOGAR_KEY = "gc-hogar";

const COLORES_MIEMBRO = ["#7a4ec5", "#1f8a5b", "#cf6a3f", "#e6a91a", "#d24773", "#3a7bd5"];

const CAT_GASTOS_DEFAULT = [
  { cat: "Vivienda", subs: ["Alquiler/Hipoteca", "Luz", "Agua", "Gas", "Internet"] },
  { cat: "Comida", subs: ["Supermercado"] },
  { cat: "Servicio doméstico", subs: ["Interna (mensual)", "Externa (por horas)"] },
  { cat: "Bebé", subs: ["Pañales", "Toallitas", "Ropa bebé"] },
  { cat: "Guardería", subs: ["Cuota mensual"] },
  { cat: "Transporte", subs: ["Gasolina"] },
  { cat: "Salud", subs: ["Farmacia"] },
  { cat: "Ocio", subs: ["Restaurantes", "Viajes"] },
  { cat: "Ahorro", subs: ["Ahorro mensual"] },
  { cat: "Otros", subs: ["Imprevistos", "Regalos", "Ropa"] },
];

const defaultData = () => ({
  hogar: { nombre: "Nuestro hogar", moneda: "€" },
  miembros: [],
  catGastos: JSON.parse(JSON.stringify(CAT_GASTOS_DEFAULT)),
  catIngresos: ["Nómina", "Extra", "Devolución", "Regalo", "Otros"],
  gastos: [],
  ingresos: [],
  ahorros: [],
  inversiones: [],
  propuestas: [],
  liquidaciones: [],
  objetivos: { gastoMes: 0, ahorroMes: 0, porSubcategoria: {} },
  cuentas: [],          // { id, nombre, tipo, ambito, saldoInicial, fechaInicial, color, notas, archivada }
  transferencias: [],   // { id, fecha, desdeCuenta, haciaCuenta, importe, nota, miembro }
});

// Migración: si catGastos viene de una versión antigua (array plano de strings),
// lo convertimos a la estructura jerárquica.
function migrarCategorias(s) {
  if (Array.isArray(s.catGastos) && s.catGastos.length && typeof s.catGastos[0] === "string") {
    s.catGastos = JSON.parse(JSON.stringify(CAT_GASTOS_DEFAULT));
  } else if (!Array.isArray(s.catGastos) || !s.catGastos.length) {
    s.catGastos = JSON.parse(JSON.stringify(CAT_GASTOS_DEFAULT));
  }
  return s;
}

let state = load();
let sessionUserId = sessionStorage.getItem(SESSION_KEY) || null;
let _modoApp = "comun"; // "comun" | "personal"
let _miembroActivoId = null; // miembro "registro como" (común) o el logueado (personal)

// ---------- Persistencia ----------
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    return migrarCategorias({ ...defaultData(), ...JSON.parse(raw) });
  } catch {
    return defaultData();
  }
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    if (err && (err.name === "QuotaExceededError" || /quota/i.test(err.message))) {
      alert("No queda espacio en el navegador. Exporta JSON y borra movimientos antiguos para liberar.");
    } else {
      throw err;
    }
  }
  programarAutoPush();
}

// ---------- Utilidades ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const moneda = () => (state.hogar?.moneda || "€");
const fmtMoney = (n) => {
  const v = Number(n) || 0;
  return v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + moneda();
};
const fmtFecha = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const hoyISO = () => new Date().toISOString().slice(0, 10);
const mesISO = (iso) => (iso || "").slice(0, 7);
const mesActualISO = () => hoyISO().slice(0, 7);
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const confirmar = (msg) => window.confirm(msg);

async function hashPin(memberId, pin) {
  const data = new TextEncoder().encode(`${memberId}:${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Filtros por modo (común vs personal) ----------
function esRepartoCompartido(reparto) {
  if (!reparto) return false;
  const valores = Object.values(reparto).filter((v) => Number(v) > 0);
  return valores.length > 1;
}

function gastosDelModo() {
  if (_modoApp === "comun") {
    return state.gastos.filter((g) =>
      g.tipo === "compartido" ||
      (g.tipo === "inesperado" && esRepartoCompartido(g.reparto))
    );
  }
  return state.gastos.filter((g) =>
    g.pagadoPor === _miembroActivoId && (
      g.tipo === "personal" ||
      (g.tipo === "inesperado" && !esRepartoCompartido(g.reparto))
    )
  );
}
function tipoIngreso(i) {
  return i && i.tipo === "compartido" ? "compartido" : "personal";
}
function ingresosDelModo() {
  if (_modoApp === "comun") return state.ingresos.filter((i) => tipoIngreso(i) === "compartido");
  return state.ingresos.filter((i) => i.miembro === _miembroActivoId && tipoIngreso(i) === "personal");
}
function ahorrosDelModo() {
  if (_modoApp === "comun") return state.ahorros.filter((a) => a.ambito === "compartido");
  return state.ahorros.filter((a) => a.ambito === _miembroActivoId);
}
function inversionesDelModo() {
  if (_modoApp === "comun") return state.inversiones.filter((i) => i.ambito === "compartido");
  return state.inversiones.filter((i) => i.ambito === _miembroActivoId);
}
function cuentasDelModo() {
  const arr = state.cuentas || [];
  if (_modoApp === "comun") return arr.filter((c) => c.ambito === "compartido" && !c.archivada);
  return arr.filter((c) => c.ambito === _miembroActivoId && !c.archivada);
}
function cuentasComunes() {
  return (state.cuentas || []).filter((c) => c.ambito === "compartido" && !c.archivada);
}
function nombreCuenta(id) {
  const c = (state.cuentas || []).find((x) => x.id === id);
  return c ? c.nombre : "(cuenta eliminada)";
}
function saldoCuenta(cuentaId) {
  const cuenta = (state.cuentas || []).find((c) => c.id === cuentaId);
  if (!cuenta) return 0;
  let saldo = Number(cuenta.saldoInicial) || 0;
  state.ingresos.forEach((i) => { if (i.cuenta === cuentaId) saldo += Number(i.importe) || 0; });
  state.gastos.forEach((g) => { if (g.cuenta === cuentaId) saldo -= Number(g.importe) || 0; });
  (state.transferencias || []).forEach((t) => {
    if (t.desdeCuenta === cuentaId) saldo -= Number(t.importe) || 0;
    if (t.haciaCuenta === cuentaId) saldo += Number(t.importe) || 0;
  });
  state.ahorros.forEach((a) => {
    (a.movimientos || []).forEach((m) => {
      if (m.cuenta === cuentaId) saldo -= Number(m.importe) || 0;
    });
  });
  return saldo;
}

function getMiembro(id) { return state.miembros.find((m) => m.id === id); }
function nombreMiembro(id) { return getMiembro(id)?.nombre || "?"; }
function userActual() { return getMiembro(sessionUserId); }
function otroMiembro() {
  return state.miembros.find((m) => m.id !== sessionUserId);
}
function pareja() {
  // Devuelve array [yo, otro] o tantos miembros como haya
  const yo = userActual();
  if (!yo) return state.miembros.slice();
  return [yo, ...state.miembros.filter((m) => m.id !== yo.id)];
}

// ---------- Toast ----------
let _toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add("hidden"), 2400);
}

// ============================================================
// SINCRONIZACIÓN EN LA NUBE (JSONBin.io)
// ============================================================
const JSONBIN_API = "https://api.jsonbin.io/v3";
const SYNC_CODE_KEY = "gc-sync-code";     // BIN_ID en JSONBin
const SYNC_AUTO_KEY = "gc-sync-auto";
const SYNC_KEY_KEY = "gc-sync-master";    // JSONBin X-MASTER-KEY

let syncCode = localStorage.getItem(SYNC_CODE_KEY) || "";
let syncMasterKey = localStorage.getItem(SYNC_KEY_KEY) || "";
let syncAuto = localStorage.getItem(SYNC_AUTO_KEY) !== "0";
let _pushTimer = null;
let _pollTimer = null;

function syncCodeOk() { return syncCode && syncCode.length >= 6 && syncMasterKey && syncMasterKey.length >= 20; }

async function jsonbinCreate(data) {
  const res = await fetch(`${JSONBIN_API}/b`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": syncMasterKey,
      "X-Bin-Private": "true",
      "X-Bin-Name": "gastos-casa-" + Date.now(),
    },
    body: JSON.stringify(data || {}),
  });
  if (!res.ok) throw new Error("Crear bin: HTTP " + res.status);
  const out = await res.json();
  return out.metadata.id;
}

async function jsonbinGet(binId) {
  const res = await fetch(`${JSONBIN_API}/b/${binId}/latest`, {
    headers: {
      "X-Master-Key": syncMasterKey,
      "X-Bin-Meta": "false",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

async function jsonbinUpdate(binId, data) {
  const res = await fetch(`${JSONBIN_API}/b/${binId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": syncMasterKey,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

function actualizarSyncStatus(text, ok = true) {
  const el = $("#sync-status");
  const dot = $("#sync-dot");
  if (el) el.textContent = text || "";
  if (dot) {
    dot.classList.remove("ok", "err", "wait");
    if (text) dot.classList.add(ok ? "ok" : "err");
  }
}

function programarAutoPush() {
  if (!syncAuto || !syncCodeOk()) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => pushToCloud(true), 1500);
}

async function pushToCloud(silent = false) {
  if (!syncCodeOk()) {
    if (!silent) toast("Falta Master Key o sync code");
    return;
  }
  try {
    const version = Date.now();
    const payload = { ...state, _cloudVersion: version };
    await jsonbinUpdate(syncCode, payload);
    state._cloudVersion = version;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    actualizarSyncStatus(`✓ ${new Date().toLocaleTimeString("es-ES")}`);
    if (!silent) toast("Datos subidos a la nube");
  } catch (err) {
    actualizarSyncStatus(`✗ ${err.message}`, false);
    if (!silent) toast("Error al subir: " + err.message);
  }
}

async function pullFromCloud(silent = false) {
  if (!syncCodeOk()) {
    if (!silent) toast("Falta Master Key o sync code");
    return null;
  }
  try {
    const cloud = await jsonbinGet(syncCode);
    if (!cloud || !cloud._cloudVersion) {
      if (!silent) toast("No hay datos en la nube todavía");
      return null;
    }
    if (cloud._cloudVersion === state._cloudVersion) {
      if (!silent) toast("Ya tienes la última versión");
      return cloud;
    }
    if (!silent && !confirmar("¿Reemplazar los datos locales por los de la nube?")) return null;
    state = migrarCategorias({ ...defaultData(), ...cloud });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    renderAll();
    actualizarSyncStatus(`✓ Bajado · ${new Date().toLocaleTimeString("es-ES")}`);
    if (!silent) toast("Datos descargados");
    return cloud;
  } catch (err) {
    actualizarSyncStatus(`✗ ${err.message}`, false);
    if (!silent) toast("Error al bajar: " + err.message);
    return null;
  }
}

function _hayDatos(s) {
  if (!s) return false;
  return (s.miembros && s.miembros.length) || (s.gastos && s.gastos.length) ||
         (s.ingresos && s.ingresos.length) || (s.ahorros && s.ahorros.length) ||
         (s.inversiones && s.inversiones.length);
}

async function autoSyncAlCargar() {
  if (!syncAuto || !syncCodeOk()) return;
  actualizarSyncStatus("Comprobando…");
  try {
    const cloud = await jsonbinGet(syncCode);
    const localV = state._cloudVersion || 0;
    const cloudV = (cloud && cloud._cloudVersion) || 0;
    const hasLocal = _hayDatos(state);
    const hasCloud = _hayDatos(cloud);

    if (localV === 0 && hasLocal && hasCloud) {
      const elegirNube = window.confirm(
        "Sincronización con la nube — primer uso en este dispositivo.\n\n" +
        "• Hay datos guardados aquí.\n• Hay datos en la nube.\n\n" +
        "OK = BAJAR los de la nube (reemplaza los de aquí).\n" +
        "Cancelar = SUBIR los de aquí (reemplaza los de la nube)."
      );
      if (elegirNube) {
        state = migrarCategorias({ ...defaultData(), ...cloud });
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
        renderAll();
        actualizarSyncStatus(`✓ Desde nube · ${new Date().toLocaleTimeString("es-ES")}`);
      } else {
        await pushToCloud(true);
      }
      return;
    }
    if (!cloudV) {
      if (hasLocal) await pushToCloud(true);
      else actualizarSyncStatus("Nube vacía");
      return;
    }
    if (cloudV === localV) {
      actualizarSyncStatus(`✓ ${new Date(cloudV).toLocaleTimeString("es-ES")}`);
      return;
    }
    if (cloudV > localV) {
      state = migrarCategorias({ ...defaultData(), ...cloud });
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
      renderAll();
      actualizarSyncStatus(`✓ Desde nube · ${new Date().toLocaleTimeString("es-ES")}`);
    } else {
      await pushToCloud(true);
    }
  } catch (err) {
    actualizarSyncStatus(`✗ ${err.message}`, false);
  }
}

function arrancarPollSync() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && syncAuto && syncCodeOk()) autoSyncAlCargar();
  });
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => {
    if (document.visibilityState === "visible" && syncAuto && syncCodeOk()) autoSyncAlCargar();
  }, 3 * 60 * 1000);
}

function generarSyncCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ============================================================
// LOGIN / SETUP
// ============================================================
function mostrarLogin() {
  document.body.classList.add("no-user");
  $("#login-screen").classList.remove("hidden");
  $("#app").classList.add("hidden");

  const quick = $("#login-quick");
  const classic = $("#login-card-classic");

  if (appConfigOK() && quick) {
    // Pantalla simple: 4 botones por miembro
    quick.classList.remove("hidden");
    if (classic) classic.classList.add("hidden");
    renderLoginQuick();
    return;
  }

  // Pantalla clásica (setup + picker)
  if (quick) quick.classList.add("hidden");
  if (classic) classic.classList.remove("hidden");

  const config = $("#login-config");
  const pick = $("#login-pick");
  const join = $("#login-join");
  if (!state.miembros.length) {
    config.classList.remove("hidden");
    pick.classList.add("hidden");
    if (join) join.open = false;
  } else {
    config.classList.add("hidden");
    pick.classList.remove("hidden");
    if (join) join.open = false;
    renderLoginMembers();
  }
}

function renderLoginQuick() {
  const wrap = $("#login-quick-hogares");
  if (!wrap) return;
  wrap.innerHTML = APP_CONFIG.hogares.map((h) => `
    <button type="button" class="casa-btn" data-hogar-key="${escape(h.key)}" style="--c:${escape(h.color)}">
      <span class="casa-icon" style="background:${escape(h.color)}">🏠</span>
      <span class="casa-info">
        <strong>${escape(h.nombre)}</strong>
        <span class="muted small">${escape(h.miembros.join(" · "))}</span>
      </span>
    </button>
  `).join("");

  $("#form-pass-casa").classList.add("hidden");
  $("#pass-casa-err").classList.add("hidden");
  $("#pass-casa-help").classList.add("hidden");
  wrap.querySelectorAll(".casa-btn").forEach((b) => {
    b.addEventListener("click", () => quickPickHogar(b.dataset.hogarKey));
  });
}

let _hogarSeleccionado = null; // hogar elegido, esperando pass

async function quickPickHogar(hogarKey) {
  const hogar = APP_CONFIG.hogares.find((h) => h.key === hogarKey);
  if (!hogar) return;
  _hogarSeleccionado = hogar;

  // Descargar bin
  syncMasterKey = APP_CONFIG.masterKey;
  syncCode = hogar.binId;
  localStorage.setItem(SYNC_KEY_KEY, syncMasterKey);
  localStorage.setItem(SYNC_CODE_KEY, syncCode);
  localStorage.setItem(SYNC_AUTO_KEY, "1");
  syncAuto = true;

  try {
    toast("Conectando con " + hogar.nombre + "…");
    const cloud = await jsonbinGet(hogar.binId);
    const miembrosBin = (cloud && Array.isArray(cloud.miembros)) ? cloud.miembros : [];
    const esperados = hogar.miembros.map((s) => s.toUpperCase());
    const nombresBin = miembrosBin.map((m) => (m.nombre || "").trim().toUpperCase());
    const coincidenTodos = miembrosBin.length > 0 && esperados.every((n) => nombresBin.includes(n));

    if (!coincidenTodos) {
      const enBin = miembrosBin.length ? miembrosBin.map((m) => m.nombre).join(", ") : "(vacío)";
      if (window.confirm(
        `El bin de "${hogar.nombre}" contiene: ${enBin}\n\n` +
        `Esta casa debería tener: ${hogar.miembros.join(" y ")}\n\n` +
        `¿Inicializar el hogar con ${hogar.miembros.join(" y ")}?\n` +
        `(Te pediré crear la contraseña de la casa.)`
      )) {
        await inicializarHogar(hogar);
      }
      return;
    }
    state = migrarCategorias({ ...defaultData(), ...cloud });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    localStorage.setItem(HOGAR_KEY, hogarKey);
  } catch (err) {
    toast("Error al conectar: " + err.message);
    return;
  }

  // Pedir pass de casa
  mostrarFormPassCasa(hogar);
}

function mostrarFormPassCasa(hogar) {
  const form = $("#form-pass-casa");
  $("#pass-casa-nombre").textContent = hogar.nombre;
  $("#pass-casa-err").classList.add("hidden");
  const help = $("#pass-casa-help");
  const submit = $("#btn-pass-casa-submit");

  const tienePass = !!(state.hogar && state.hogar.passCasaHash);
  if (tienePass) {
    help.classList.add("hidden");
    submit.textContent = "Entrar";
  } else {
    help.classList.remove("hidden");
    submit.textContent = "Crear contraseña y entrar";
  }
  form.classList.remove("hidden");
  $("#login-quick-hogares").classList.add("hidden");
  setTimeout(() => form.querySelector("input[name=pass]").focus(), 50);
}

async function inicializarHogar(hogar) {
  // Crea miembros con PIN compartido vacío de momento; la pass casa se crea después
  const miembros = hogar.miembros.map((nombre, i) => ({
    id: uid(),
    nombre,
    pinHash: "",  // se establecerá la primera vez que se entre en Modo Personal
    color: COLORES_MIEMBRO[i % COLORES_MIEMBRO.length],
  }));
  const nuevoState = {
    ...defaultData(),
    hogar: { nombre: hogar.nombre, moneda: "€" },
    miembros,
    _cloudVersion: Date.now(),
  };
  try {
    syncMasterKey = APP_CONFIG.masterKey;
    syncCode = hogar.binId;
    localStorage.setItem(SYNC_KEY_KEY, syncMasterKey);
    localStorage.setItem(SYNC_CODE_KEY, syncCode);
    await jsonbinUpdate(hogar.binId, nuevoState);
    state = nuevoState;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    localStorage.setItem(HOGAR_KEY, hogar.key);
    toast("Hogar inicializado · ahora crea la contraseña");
    mostrarFormPassCasa(hogar);
  } catch (err) {
    toast("Error al inicializar: " + err.message);
  }
}

// Submit form pass casa
const _formPassCasa = $("#form-pass-casa");
if (_formPassCasa) {
  _formPassCasa.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!_hogarSeleccionado) return;
    const pass = e.target.pass.value.trim();
    if (!/^\d{4}$/.test(pass)) { toast("Contraseña debe ser 4 dígitos"); return; }
    const hash = await hashPin("casa:" + _hogarSeleccionado.key, pass);
    const tienePass = !!(state.hogar && state.hogar.passCasaHash);
    if (tienePass) {
      if (hash !== state.hogar.passCasaHash) {
        $("#pass-casa-err").classList.remove("hidden");
        return;
      }
    } else {
      // Crear pass
      state.hogar.passCasaHash = hash;
      save(); // sube al bin
    }
    entrarEnHogar(_hogarSeleccionado);
  });
}

const _btnPassCancel = $("#btn-pass-casa-cancel");
if (_btnPassCancel) {
  _btnPassCancel.addEventListener("click", () => {
    _hogarSeleccionado = null;
    $("#form-pass-casa").classList.add("hidden");
    $("#login-quick-hogares").classList.remove("hidden");
  });
}

function entrarEnHogar(hogar) {
  // Entra a Modo Común. miembro activo = el último usado o el primero
  const lastMember = localStorage.getItem("gc-last-miembro-" + hogar.key);
  const miembro = state.miembros.find((m) => m.id === lastMember) || state.miembros[0];
  _miembroActivoId = miembro.id;
  _modoApp = "comun";
  sessionUserId = miembro.id;
  sessionStorage.setItem(SESSION_KEY, miembro.id);
  document.body.classList.remove("no-user");
  document.body.classList.add("modo-comun");
  document.body.classList.remove("modo-personal");
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  renderHeaderModo();
  renderAll();
}

function renderHeaderModo() {
  const sub = $("#brand-sub");
  if (sub) sub.textContent = state.hogar.nombre || "Hogar";
  const badge = $("#modo-badge");
  if (badge) {
    badge.textContent = _modoApp === "comun" ? "Común" : "Personal";
    badge.className = "modo-badge " + (_modoApp === "comun" ? "modo-comun-badge" : "modo-personal-badge");
  }
  const sel = $("#sel-registro-como");
  if (sel) {
    sel.innerHTML = state.miembros.map((m) => `<option value="${escape(m.id)}" ${m.id === _miembroActivoId ? "selected" : ""}>soy ${escape(m.nombre)}</option>`).join("");
    sel.classList.toggle("hidden", _modoApp !== "comun");
  }
  const btnPers = $("#btn-modo-personal");
  const btnCom = $("#btn-modo-comun");
  if (btnPers && btnCom) {
    btnPers.classList.toggle("hidden", _modoApp !== "comun");
    btnCom.classList.toggle("hidden", _modoApp !== "personal");
  }
}

// Cambio de miembro activo en común
const _selRegistro = $("#sel-registro-como");
if (_selRegistro) {
  _selRegistro.addEventListener("change", (e) => {
    _miembroActivoId = e.target.value;
    sessionUserId = _miembroActivoId;
    const hogarKey = localStorage.getItem(HOGAR_KEY);
    if (hogarKey) localStorage.setItem("gc-last-miembro-" + hogarKey, _miembroActivoId);
    renderHeaderModo();
    renderAll();
  });
}

// Entrar Modo Personal: pide PIN
const _btnModoPersonal = $("#btn-modo-personal");
if (_btnModoPersonal) {
  _btnModoPersonal.addEventListener("click", () => {
    const miembro = state.miembros.find((m) => m.id === _miembroActivoId);
    if (!miembro) return;
    $("#modal-pin-nombre").textContent = miembro.nombre;
    $("#modal-pin-err").classList.add("hidden");
    const help = $("#modal-pin-help");
    const sub = $("#form-modal-pin button[type=submit]");
    if (!miembro.pinHash) {
      help.classList.remove("hidden");
      sub.textContent = "Crear y entrar";
    } else {
      help.classList.add("hidden");
      sub.textContent = "Entrar";
    }
    $("#modal-pin").classList.remove("hidden");
    const inp = $("#form-modal-pin input[name=pin]");
    inp.value = "";
    setTimeout(() => inp.focus(), 50);
  });
}

const _btnModoComun = $("#btn-modo-comun");
if (_btnModoComun) {
  _btnModoComun.addEventListener("click", () => {
    _modoApp = "comun";
    document.body.classList.add("modo-comun");
    document.body.classList.remove("modo-personal");
    renderHeaderModo();
    renderAll();
  });
}

// Submit modal PIN
const _formModalPin = $("#form-modal-pin");
if (_formModalPin) {
  _formModalPin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = e.target.pin.value.trim();
    if (!/^\d{4}$/.test(pin)) { toast("PIN debe ser 4 dígitos"); return; }
    const miembro = state.miembros.find((m) => m.id === _miembroActivoId);
    if (!miembro) return;
    const hash = await hashPin(miembro.id, pin);
    if (!miembro.pinHash) {
      // Crear PIN nuevo
      miembro.pinHash = hash;
      save();
    } else if (hash !== miembro.pinHash) {
      $("#modal-pin-err").classList.remove("hidden");
      return;
    }
    _modoApp = "personal";
    document.body.classList.remove("modo-comun");
    document.body.classList.add("modo-personal");
    $("#modal-pin").classList.add("hidden");
    renderHeaderModo();
    renderAll();
  });
}
const _btnModalCancel = $("#btn-modal-pin-cancel");
if (_btnModalCancel) {
  _btnModalCancel.addEventListener("click", () => {
    $("#modal-pin").classList.add("hidden");
  });
}

function entrarComo(miembro) {
  // Entra a la app en modo Común con el miembro activo dado
  _miembroActivoId = miembro.id;
  _modoApp = "comun";
  sessionUserId = miembro.id;
  sessionStorage.setItem(SESSION_KEY, miembro.id);
  document.body.classList.remove("no-user");
  document.body.classList.add("modo-comun");
  document.body.classList.remove("modo-personal");
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  renderHeaderModo();
  renderAll();
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionUserId = null;
  mostrarLogin();
}

function renderLoginMembers() {
  const wrap = $("#login-members");
  wrap.innerHTML = "";
  state.miembros.forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "member-btn";
    b.innerHTML = `<span class="avatar" style="background:${escape(m.color)}">${escape(m.nombre.slice(0, 1).toUpperCase())}</span><span class="nm">${escape(m.nombre)}</span>`;
    b.addEventListener("click", () => pedirPin(m));
    wrap.appendChild(b);
  });
  $("#form-login-pin").classList.add("hidden");
  $("#login-err").classList.add("hidden");
}

let _loginPickedMember = null;
function pedirPin(miembro) {
  _loginPickedMember = miembro;
  $("#login-name").textContent = miembro.nombre;
  $("#form-login-pin").classList.remove("hidden");
  $("#login-err").classList.add("hidden");
  const inp = $("#form-login-pin input[name=pin]");
  inp.value = "";
  inp.focus();
}

$("#btn-login-cancel").addEventListener("click", () => {
  _loginPickedMember = null;
  $("#form-login-pin").classList.add("hidden");
});

// Login rápido (modo preconfigurado): cancelar y submit
const _btnQuickCancel = $("#btn-quick-cancel");
if (_btnQuickCancel) {
  _btnQuickCancel.addEventListener("click", () => {
    _quickPick = null;
    $("#form-quick-pin").classList.add("hidden");
  });
}
const _formQuickPin = $("#form-quick-pin");
if (_formQuickPin) {
  _formQuickPin.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!_quickPick) return;
    const pin = e.target.pin.value.trim();
    const hogar = APP_CONFIG.hogares.find((h) => h.key === _quickPick.hogarKey);
    const target = _quickPick.miembroNombre.trim().toUpperCase();

    let miembro = state.miembros.find((m) => (m.nombre || "").trim().toUpperCase() === target);

    // Si no lo encuentra en el state local, forzamos re-descarga del bin (puede que el state esté desactualizado)
    if (!miembro && hogar) {
      try {
        const cloud = await jsonbinGet(hogar.binId);
        if (cloud && cloud.miembros && cloud.miembros.length) {
          state = migrarCategorias({ ...defaultData(), ...cloud });
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
          localStorage.setItem(HOGAR_KEY, hogar.key);
          miembro = state.miembros.find((m) => (m.nombre || "").trim().toUpperCase() === target);
        }
      } catch {}
    }

    if (!miembro) {
      const nombres = state.miembros.map((m) => m.nombre).join(", ") || "(ninguno)";
      window.alert(`Miembro "${_quickPick.miembroNombre}" no se encuentra.\n\nEn este hogar (${hogar?.nombre || "?"}) hay: ${nombres}\n\nSi los nombres son distintos, dime esos nombres y te lo arreglo.`);
      return;
    }

    const h = await hashPin(miembro.id, pin);
    if (h !== miembro.pinHash) {
      $("#quick-login-err").classList.remove("hidden");
      return;
    }
    entrarComo(miembro);
  });
}

$("#form-login-pin").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!_loginPickedMember) return;
  const pin = e.target.pin.value.trim();
  const h = await hashPin(_loginPickedMember.id, pin);
  if (h !== _loginPickedMember.pinHash) {
    $("#login-err").classList.remove("hidden");
    return;
  }
  entrarComo(_loginPickedMember);
});

$("#form-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const n1 = f.nombre1.value.trim();
  const n2 = f.nombre2.value.trim();
  const p1 = f.pin1.value.trim();
  const p2 = f.pin2.value.trim();
  // Si la app tiene Master Key configurada, la usamos automáticamente.
  // Si no, pedimos al usuario que la introduzca.
  const masterKey = (APP_CONFIG.masterKey && !APP_CONFIG.masterKey.startsWith("PENDIENTE"))
    ? APP_CONFIG.masterKey
    : (f.masterKey ? f.masterKey.value.trim() : "");
  if (!n1 || !n2 || !/^\d{4}$/.test(p1) || !/^\d{4}$/.test(p2)) {
    toast("Revisa nombres y PINs");
    return;
  }
  if (!masterKey || masterKey.length < 20) {
    toast("Falta Master Key");
    return;
  }
  try {
    toast("Creando bin en JSONBin…");
    syncMasterKey = masterKey;
    localStorage.setItem(SYNC_KEY_KEY, syncMasterKey);

    const m1 = { id: uid(), nombre: n1, color: COLORES_MIEMBRO[0] };
    const m2 = { id: uid(), nombre: n2, color: COLORES_MIEMBRO[1] };
    m1.pinHash = await hashPin(m1.id, p1);
    m2.pinHash = await hashPin(m2.id, p2);
    state.miembros = [m1, m2];
    state.hogar.nombre = state.hogar.nombre || `Casa de ${n1} y ${n2}`;

    const binId = await jsonbinCreate({ ...state, _cloudVersion: Date.now() });
    syncCode = binId;
    localStorage.setItem(SYNC_CODE_KEY, syncCode);
    localStorage.setItem(SYNC_AUTO_KEY, "1");
    syncAuto = true;
    save();
    window.alert(
      "Hogar creado.\n\n" +
      "Sync code (Bin ID):\n" + binId + "\n\n" +
      "Anota este código. Tu pareja lo necesitará para conectar su dispositivo."
    );
    mostrarLogin();
  } catch (err) {
    toast("Error: " + err.message);
  }
});

$("#form-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const masterKey = (APP_CONFIG.masterKey && !APP_CONFIG.masterKey.startsWith("PENDIENTE"))
    ? APP_CONFIG.masterKey
    : (e.target.masterKey ? e.target.masterKey.value.trim() : "");
  const code = e.target.syncCode.value.trim();
  if (!masterKey || masterKey.length < 20) { toast("Falta Master Key"); return; }
  if (code.length < 6) { toast("Sync code demasiado corto"); return; }
  syncMasterKey = masterKey;
  syncCode = code;
  localStorage.setItem(SYNC_KEY_KEY, syncMasterKey);
  localStorage.setItem(SYNC_CODE_KEY, syncCode);
  localStorage.setItem(SYNC_AUTO_KEY, "1");
  syncAuto = true;
  try {
    const cloud = await jsonbinGet(syncCode);
    if (!cloud || !cloud.miembros || !cloud.miembros.length) {
      toast("Ese sync code no tiene un hogar configurado todavía");
      return;
    }
    state = migrarCategorias({ ...defaultData(), ...cloud });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
    toast("Conectado al hogar");
    mostrarLogin();
  } catch (err) {
    toast("Error al conectar: " + err.message);
  }
});

$("#btn-logout").addEventListener("click", logout);
const _btnLogout2 = $("#btn-logout-2");
if (_btnLogout2) _btnLogout2.addEventListener("click", logout);

// ============================================================
// NAVEGACIÓN (tabs / sidebar)
// ============================================================
function setupTabs() {
  $$("#tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tab;
      $$("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${t}`));
      document.body.classList.remove("sidebar-open");

      if (t === "seguimiento") {
        _segActivo = true;
        renderSeguimiento();
      } else {
        _segActivo = false;
      }
      if (t === "objetivos") {
        renderObjetivos();
      }
      if (t === "cuentas") {
        renderCuentas();
      }
    });
  });

  $("#btn-hamburger").addEventListener("click", () => {
    document.body.classList.toggle("sidebar-open");
  });
  $("#sidebar-backdrop").addEventListener("click", () => {
    document.body.classList.remove("sidebar-open");
  });
}

// ============================================================
// GASTOS
// ============================================================
function repartoPorDefecto() {
  const ms = state.miembros;
  if (!ms.length) return {};
  // Si hay reparto configurado a nivel hogar y suma 100, usarlo
  const rConfig = state.hogar && state.hogar.repartoDefault ? state.hogar.repartoDefault : null;
  if (rConfig) {
    const total = ms.reduce((a, m) => a + (Number(rConfig[m.id]) || 0), 0);
    if (total === 100) {
      const r = {};
      ms.forEach((m) => { r[m.id] = Number(rConfig[m.id]) || 0; });
      return r;
    }
  }
  // Fallback: dividir equitativamente
  const pct = Math.floor(100 / ms.length);
  const r = {};
  ms.forEach((m, i) => { r[m.id] = (i === ms.length - 1) ? 100 - pct * (ms.length - 1) : pct; });
  return r;
}

function repartoTodoPara(memberId) {
  const r = {};
  state.miembros.forEach((m) => { r[m.id] = m.id === memberId ? 100 : 0; });
  return r;
}

function renderRepartoInputs(reparto, tipo) {
  const wrap = $("#reparto-inputs");
  wrap.innerHTML = "";
  state.miembros.forEach((m) => {
    const row = document.createElement("div");
    row.className = "rep-row";
    row.innerHTML = `
      <span class="rep-name" style="--c:${escape(m.color)}">${escape(m.nombre)}</span>
      <input type="number" min="0" max="100" step="1" data-mid="${escape(m.id)}" value="${reparto[m.id] ?? 0}" />
      <span>%</span>`;
    wrap.appendChild(row);
  });
  wrap.classList.toggle("dim", tipo !== "compartido");
}

function leerReparto() {
  const r = {};
  let sum = 0;
  $$("#reparto-inputs input").forEach((inp) => {
    const v = Math.max(0, Math.min(100, Number(inp.value) || 0));
    r[inp.dataset.mid] = v;
    sum += v;
  });
  if (sum === 0 && state.miembros.length) {
    return repartoPorDefecto();
  }
  if (sum !== 100) {
    const factor = 100 / sum;
    Object.keys(r).forEach((k) => { r[k] = Math.round(r[k] * factor * 100) / 100; });
  }
  return r;
}

function getSubsDe(cat) {
  const item = state.catGastos.find((c) => c.cat === cat);
  return item ? (item.subs || []) : [];
}
function actualizarSubcats(catSelect, subSelect) {
  const subs = getSubsDe(catSelect.value);
  subSelect.innerHTML = subs.length
    ? subs.map((s) => `<option>${escape(s)}</option>`).join("")
    : `<option value="">—</option>`;
}

function preparaFormGasto() {
  const f = $("#form-gasto");
  f.fecha.value = hoyISO();
  const catSel = $("#sel-cat-gasto");
  const subSel = $("#sel-subcat-gasto");
  catSel.innerHTML = state.catGastos.map((c) => `<option>${escape(c.cat)}</option>`).join("");
  actualizarSubcats(catSel, subSel);
  catSel.onchange = () => actualizarSubcats(catSel, subSel);

  // Tipo según modo
  if (_modoApp === "comun") {
    f.tipo.innerHTML = `<option value="compartido">Compartido (hogar)</option><option value="inesperado">Inesperado (hogar)</option>`;
  } else {
    f.tipo.innerHTML = `<option value="personal">Personal (mío)</option><option value="inesperado">Inesperado (mío)</option>`;
  }

  // Pagador: en común permite elegir, en personal es el miembro activo
  if (_modoApp === "comun") {
    $("#sel-pagador").innerHTML = state.miembros.map((m) => `<option value="${escape(m.id)}" ${m.id === _miembroActivoId ? "selected" : ""}>${escape(m.nombre)}</option>`).join("");
  } else {
    const yo = getMiembro(_miembroActivoId);
    $("#sel-pagador").innerHTML = yo ? `<option value="${escape(yo.id)}" selected>${escape(yo.nombre)}</option>` : "";
  }
  renderRepartoInputs(repartoPorDefecto(), _modoApp === "comun" ? "compartido" : "personal");

  // Filtro de categoría
  const filtroCat = $("#filtro-cat-gasto");
  if (filtroCat) {
    const actual = filtroCat.value;
    filtroCat.innerHTML = `<option value="">Todas</option>` +
      state.catGastos.map((c) => `<option ${actual === c.cat ? "selected" : ""}>${escape(c.cat)}</option>`).join("");
  }

  f.tipo.onchange = () => {
    const t = f.tipo.value;
    if (t === "compartido") {
      renderRepartoInputs(repartoPorDefecto(), "compartido");
    } else if (t === "personal") {
      renderRepartoInputs(repartoTodoPara(f.pagadoPor.value), "personal");
    } else if (t === "inesperado") {
      if (_modoApp === "comun") renderRepartoInputs(repartoPorDefecto(), "compartido");
      else renderRepartoInputs(repartoTodoPara(f.pagadoPor.value), "personal");
    }
  };
  f.pagadoPor.onchange = () => {
    const t = f.tipo.value;
    if (t === "personal" || (t === "inesperado" && _modoApp === "personal")) {
      renderRepartoInputs(repartoTodoPara(f.pagadoPor.value), "personal");
    }
  };
  $("#btn-reparto-igual").onclick = () => renderRepartoInputs(repartoPorDefecto(), f.tipo.value);
}

$("#form-gasto").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const tipo = f.tipo.value;
  const pagadoPor = f.pagadoPor.value;
  const soloPagador = (tipo === "personal") || (tipo === "inesperado" && _modoApp === "personal");
  const reparto = soloPagador ? repartoTodoPara(pagadoPor) : leerReparto();
  state.gastos.push({
    id: uid(),
    fecha: f.fecha.value,
    descripcion: f.descripcion.value.trim(),
    importe: Number(f.importe.value),
    tipo,
    categoria: f.categoria.value,
    subcategoria: f.subcategoria ? f.subcategoria.value : "",
    pagadoPor,
    reparto,
    nota: f.nota.value.trim(),
    creadoPor: sessionUserId,
    creadoEn: Date.now(),
  });
  save();
  f.reset();
  f.fecha.value = hoyISO();
  preparaFormGasto();
  renderGastos();
  renderInicio();
  renderCuadre();
  toast("Gasto añadido");
});

function gastosFiltrados() {
  const mes = $("#filtro-mes-gasto").value;
  const tipo = $("#filtro-tipo-gasto") ? $("#filtro-tipo-gasto").value : "";
  const cat = $("#filtro-cat-gasto") ? $("#filtro-cat-gasto").value : "";
  return gastosDelModo()
    .slice()
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))
    .filter((g) => {
      if (mes && mesISO(g.fecha) !== mes) return false;
      if (tipo && g.tipo !== tipo) return false;
      if (cat && g.categoria !== cat) return false;
      return true;
    });
}

function renderGastos() {
  const tb = $("#tabla-gastos");
  const list = gastosFiltrados();
  let total = 0;
  tb.innerHTML = list.map((g) => {
    total += Number(g.importe) || 0;
    const tipoLbl = g.tipo === "compartido" ? "Compartido" : g.tipo === "personal" ? "Personal" : "Inesperado";
    const subs = getSubsDe(g.categoria);
    const catOptions = state.catGastos.map((c) => `<option ${c.cat === g.categoria ? "selected" : ""}>${escape(c.cat)}</option>`).join("");
    const subOptions = subs.length
      ? subs.map((s) => `<option ${s === g.subcategoria ? "selected" : ""}>${escape(s)}</option>`).join("")
      : `<option value="">—</option>`;
    const esCompartido = _modoApp === "comun" && (g.tipo === "compartido" || (g.tipo === "inesperado" && esRepartoCompartido(g.reparto)));
    const repartoResumen = esCompartido
      ? state.miembros
          .filter((m) => Number(g.reparto?.[m.id]) > 0)
          .map((m) => `<span class="rep-chip" style="--c:${escape(m.color)}" title="${escape(m.nombre)}">${escape(m.nombre.charAt(0))} ${Number(g.reparto[m.id])}%</span>`)
          .join("")
      : "";
    const repartoEditor = esCompartido
      ? `<tr class="reparto-editor-row" data-for="${escape(g.id)}" hidden>
          <td colspan="7">
            <div class="reparto-editor">
              <strong class="reparto-editor-title">Reparto del pago</strong>
              <div class="reparto-editor-inputs">
                ${state.miembros.map((m) => `
                  <div class="rep-row">
                    <span class="rep-name" style="--c:${escape(m.color)}">${escape(m.nombre)}</span>
                    <input type="number" min="0" max="100" step="1" data-mid="${escape(m.id)}" value="${Number(g.reparto?.[m.id]) || 0}" />
                    <span>%</span>
                  </div>`).join("")}
              </div>
              <div class="reparto-editor-suma muted small">Suma: <span data-suma>0</span>%</div>
              <div class="reparto-editor-actions">
                <button type="button" class="ghost small" data-reparto-igual="${escape(g.id)}">Repartir igual</button>
                <button type="button" class="ghost small" data-reparto-default="${escape(g.id)}">Usar por defecto</button>
                <button type="button" class="ghost small" data-reparto-cancel="${escape(g.id)}">Cancelar</button>
                <button type="button" class="primary small" data-reparto-save="${escape(g.id)}">Aplicar</button>
              </div>
            </div>
          </td>
        </tr>`
      : "";
    return `<tr data-id="${escape(g.id)}">
      <td>${fmtFecha(g.fecha)}</td>
      <td>${escape(g.descripcion)}${g.nota ? `<div class="muted small">${escape(g.nota)}</div>` : ""}</td>
      <td><span class="badge badge-${g.tipo}">${tipoLbl}</span>${repartoResumen ? `<div class="rep-resumen">${repartoResumen}</div>` : ""}</td>
      <td class="cat-edit-cell">
        <select class="row-cat" data-id="${escape(g.id)}" title="Categoría">${catOptions}</select>
        <select class="row-sub" data-id="${escape(g.id)}" title="Subcategoría">${subOptions}</select>
      </td>
      <td><span class="chip" style="--c:${escape(getMiembro(g.pagadoPor)?.color || "#888")}">${escape(nombreMiembro(g.pagadoPor))}</span></td>
      <td class="num">${fmtMoney(g.importe)}</td>
      <td class="acciones">
        ${esCompartido ? `<button class="link" data-reparto-toggle="${escape(g.id)}" title="Editar porcentaje de cada miembro">Reparto</button>` : ""}
        ${_modoApp === "personal" && (g.tipo === "personal" || g.tipo === "inesperado") ? `<button class="link" data-mover="${escape(g.id)}" title="Pasar a gasto compartido del hogar">→ Compartido</button>` : ""}
        ${_modoApp === "comun" && g.tipo === "compartido" ? `<button class="link" data-mover-personal="${escape(g.id)}" title="Pasar a gasto personal del que pagó">→ Personal</button>` : ""}
        <button class="link danger" data-del="${escape(g.id)}">Eliminar</button>
      </td>
    </tr>${repartoEditor}`;
  }).join("") || `<tr><td colspan="7" class="muted center">Sin gastos con esos filtros</td></tr>`;
  $("#suma-gastos").textContent = `· ${list.length} mov. · Total ${fmtMoney(total)}`;
  tb.querySelectorAll(".row-cat").forEach((sel) => {
    sel.addEventListener("change", () => {
      const g = state.gastos.find((x) => x.id === sel.dataset.id);
      if (!g) return;
      g.categoria = sel.value;
      const subs = getSubsDe(sel.value);
      g.subcategoria = subs.length ? subs[0] : "";
      const subSel = tb.querySelector(`.row-sub[data-id="${sel.dataset.id}"]`);
      if (subSel) {
        subSel.innerHTML = subs.length
          ? subs.map((s) => `<option ${s === g.subcategoria ? "selected" : ""}>${escape(s)}</option>`).join("")
          : `<option value="">—</option>`;
      }
      save();
      renderInicio();
      toast("Categoría actualizada");
    });
  });
  tb.querySelectorAll(".row-sub").forEach((sel) => {
    sel.addEventListener("change", () => {
      const g = state.gastos.find((x) => x.id === sel.dataset.id);
      if (!g) return;
      g.subcategoria = sel.value;
      save();
      renderInicio();
      toast("Subcategoría actualizada");
    });
  });
  tb.querySelectorAll("[data-del]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar este gasto?")) return;
      state.gastos = state.gastos.filter((x) => x.id !== b.dataset.del);
      save(); renderGastos(); renderInicio(); renderCuadre();
    });
  });
  tb.querySelectorAll("[data-mover]").forEach((b) => {
    b.addEventListener("click", () => {
      const g = state.gastos.find((x) => x.id === b.dataset.mover);
      if (!g) return;
      if (!confirmar(`Mover "${g.descripcion}" (${fmtMoney(g.importe)}) a gasto compartido del hogar.\n\nSe aplicará reparto 50/50.`)) return;
      g.tipo = "compartido";
      g.reparto = repartoPorDefecto();
      save();
      renderGastos();
      renderInicio();
      renderCuadre();
      toast("Movido a compartido");
    });
  });
  tb.querySelectorAll("[data-mover-personal]").forEach((b) => {
    b.addEventListener("click", () => {
      const g = state.gastos.find((x) => x.id === b.dataset.moverPersonal);
      if (!g) return;
      const nombre = nombreMiembro(g.pagadoPor);
      if (!confirmar(`Mover "${g.descripcion}" (${fmtMoney(g.importe)}) a gasto personal de ${nombre}.`)) return;
      g.tipo = "personal";
      g.reparto = repartoTodoPara(g.pagadoPor);
      save();
      renderGastos();
      renderInicio();
      renderCuadre();
      toast("Movido a personal de " + nombre);
    });
  });
  const editorRowFor = (id) => tb.querySelector(`.reparto-editor-row[data-for="${cssEscape(id)}"]`);
  const recalcSuma = (row) => {
    const sumaEl = row.querySelector("[data-suma]");
    if (!sumaEl) return;
    let s = 0;
    row.querySelectorAll(".reparto-editor-inputs input").forEach((inp) => { s += Number(inp.value) || 0; });
    sumaEl.textContent = s;
    sumaEl.parentElement.classList.toggle("warn", s !== 100);
  };
  tb.querySelectorAll(".reparto-editor-row").forEach((row) => {
    row.querySelectorAll(".reparto-editor-inputs input").forEach((inp) => {
      inp.addEventListener("input", () => recalcSuma(row));
    });
    recalcSuma(row);
  });
  tb.querySelectorAll("[data-reparto-toggle]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.repartoToggle;
      const row = editorRowFor(id);
      if (!row) return;
      const willOpen = row.hasAttribute("hidden");
      tb.querySelectorAll(".reparto-editor-row").forEach((r) => r.setAttribute("hidden", ""));
      if (willOpen) {
        row.removeAttribute("hidden");
        const first = row.querySelector("input");
        if (first) first.focus();
      }
    });
  });
  tb.querySelectorAll("[data-reparto-cancel]").forEach((b) => {
    b.addEventListener("click", () => {
      const g = state.gastos.find((x) => x.id === b.dataset.repartoCancel);
      const row = editorRowFor(b.dataset.repartoCancel);
      if (!row || !g) return;
      row.querySelectorAll(".reparto-editor-inputs input").forEach((inp) => {
        inp.value = Number(g.reparto?.[inp.dataset.mid]) || 0;
      });
      recalcSuma(row);
      row.setAttribute("hidden", "");
    });
  });
  tb.querySelectorAll("[data-reparto-igual]").forEach((b) => {
    b.addEventListener("click", () => {
      const row = editorRowFor(b.dataset.repartoIgual);
      if (!row) return;
      const ms = state.miembros;
      const pct = Math.floor(100 / ms.length);
      const inputs = row.querySelectorAll(".reparto-editor-inputs input");
      inputs.forEach((inp, i) => {
        inp.value = (i === inputs.length - 1) ? 100 - pct * (inputs.length - 1) : pct;
      });
      recalcSuma(row);
    });
  });
  tb.querySelectorAll("[data-reparto-default]").forEach((b) => {
    b.addEventListener("click", () => {
      const row = editorRowFor(b.dataset.repartoDefault);
      if (!row) return;
      const def = repartoPorDefecto();
      row.querySelectorAll(".reparto-editor-inputs input").forEach((inp) => {
        inp.value = Number(def[inp.dataset.mid]) || 0;
      });
      recalcSuma(row);
    });
  });
  tb.querySelectorAll("[data-reparto-save]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.repartoSave;
      const g = state.gastos.find((x) => x.id === id);
      const row = editorRowFor(id);
      if (!g || !row) return;
      const r = {};
      let sum = 0;
      row.querySelectorAll(".reparto-editor-inputs input").forEach((inp) => {
        const v = Math.max(0, Math.min(100, Number(inp.value) || 0));
        r[inp.dataset.mid] = v;
        sum += v;
      });
      if (sum === 0) { toast("La suma no puede ser 0%"); return; }
      if (sum !== 100) {
        const factor = 100 / sum;
        Object.keys(r).forEach((k) => { r[k] = Math.round(r[k] * factor * 100) / 100; });
      }
      g.reparto = r;
      save();
      renderGastos();
      renderInicio();
      renderCuadre();
      toast("Reparto actualizado");
    });
  });
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

["filtro-mes-gasto", "filtro-tipo-gasto", "filtro-cat-gasto", "filtro-ambito-gasto"].forEach((id) => {
  document.addEventListener("change", (e) => { if (e.target.id === id) renderGastos(); });
});
$("#btn-limpiar-filtro-gasto").addEventListener("click", () => {
  $("#filtro-mes-gasto").value = "";
  $("#filtro-tipo-gasto").value = "";
  const fc = $("#filtro-cat-gasto"); if (fc) fc.value = "";
  $("#filtro-ambito-gasto").value = "todos";
  renderGastos();
});

// ============================================================
// INGRESOS
// ============================================================
function preparaFormIngreso() {
  const f = $("#form-ingreso");
  f.fecha.value = hoyISO();
  $("#sel-cat-ingreso").innerHTML = state.catIngresos.map((c) => `<option>${escape(c)}</option>`).join("");
  const selTipo = $("#sel-tipo-ingreso");
  if (selTipo) selTipo.value = _modoApp === "comun" ? "compartido" : "personal";
  if (_modoApp === "comun") {
    $("#sel-miembro-ingreso").innerHTML = state.miembros.map((m) => `<option value="${escape(m.id)}" ${m.id === _miembroActivoId ? "selected" : ""}>${escape(m.nombre)}</option>`).join("");
  } else {
    const yo = getMiembro(_miembroActivoId);
    $("#sel-miembro-ingreso").innerHTML = yo ? `<option value="${escape(yo.id)}" selected>${escape(yo.nombre)}</option>` : "";
  }
}

$("#form-ingreso").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  state.ingresos.push({
    id: uid(),
    fecha: f.fecha.value,
    descripcion: f.descripcion.value.trim(),
    importe: Number(f.importe.value),
    tipo: f.tipo ? f.tipo.value : (_modoApp === "comun" ? "compartido" : "personal"),
    categoria: f.categoria.value,
    miembro: f.miembro.value,
    recurrente: f.recurrente.checked,
    nota: f.nota.value.trim(),
    creadoPor: sessionUserId,
    creadoEn: Date.now(),
  });
  save();
  f.reset();
  preparaFormIngreso();
  renderIngresos();
  renderInicio();
  toast("Ingreso añadido");
});

function ingresosFiltrados() {
  const mes = $("#filtro-mes-ingreso").value;
  return ingresosDelModo()
    .slice()
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))
    .filter((i) => {
      if (mes && mesISO(i.fecha) !== mes) return false;
      return true;
    });
}

function renderIngresos() {
  const tb = $("#tabla-ingresos");
  const list = ingresosFiltrados();
  let total = 0;
  tb.innerHTML = list.map((g) => {
    total += Number(g.importe) || 0;
    const tipo = tipoIngreso(g);
    const tipoLbl = tipo === "compartido" ? "Compartido" : "Personal";
    const toggleBtn = tipo === "personal"
      ? `<button class="link" data-tipo-ing="${escape(g.id)}|compartido" title="Pasar a ingreso compartido del hogar">→ Compartido</button>`
      : `<button class="link" data-tipo-ing="${escape(g.id)}|personal" title="Pasar a ingreso personal del miembro">→ Personal</button>`;
    return `<tr>
      <td>${fmtFecha(g.fecha)}</td>
      <td>${escape(g.descripcion)}${g.nota ? `<div class="muted small">${escape(g.nota)}</div>` : ""}</td>
      <td><span class="badge badge-${tipo === "compartido" ? "compartido" : "personal"}">${tipoLbl}</span></td>
      <td>${escape(g.categoria || "")}</td>
      <td><span class="chip" style="--c:${escape(getMiembro(g.miembro)?.color || "#888")}">${escape(nombreMiembro(g.miembro))}</span></td>
      <td class="num">${fmtMoney(g.importe)}</td>
      <td>${g.recurrente ? "↻ Mensual" : "—"}</td>
      <td class="acciones">${toggleBtn}<button class="link danger" data-del-ing="${escape(g.id)}">Eliminar</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted center">Sin ingresos</td></tr>`;
  $("#suma-ingresos").textContent = `· ${list.length} · Total ${fmtMoney(total)}`;
  tb.querySelectorAll("[data-del-ing]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar este ingreso?")) return;
      state.ingresos = state.ingresos.filter((x) => x.id !== b.dataset.delIng);
      save(); renderIngresos(); renderInicio();
    });
  });
  tb.querySelectorAll("[data-tipo-ing]").forEach((b) => {
    b.addEventListener("click", () => {
      const [id, nuevo] = b.dataset.tipoIng.split("|");
      const ing = state.ingresos.find((x) => x.id === id);
      if (!ing) return;
      ing.tipo = nuevo;
      save();
      renderIngresos();
      renderInicio();
      toast(nuevo === "compartido" ? "Movido a ingreso compartido" : "Movido a ingreso personal");
    });
  });
}

["filtro-mes-ingreso", "filtro-ambito-ingreso"].forEach((id) => {
  document.addEventListener("change", (e) => { if (e.target.id === id) renderIngresos(); });
});
$("#btn-limpiar-filtro-ingreso").addEventListener("click", () => {
  $("#filtro-mes-ingreso").value = "";
  $("#filtro-ambito-ingreso").value = "todos";
  renderIngresos();
});

// ============================================================
// AHORROS
// ============================================================
function preparaFormAhorro() {
  const sel = $("#sel-ahorro-ambito");
  if (_modoApp === "comun") {
    sel.innerHTML = `<option value="compartido">Compartido (pareja)</option>`;
  } else {
    const yo = getMiembro(_miembroActivoId);
    sel.innerHTML = yo ? `<option value="${escape(yo.id)}" selected>Personal de ${escape(yo.nombre)}</option>` : "";
  }
}

$("#form-ahorro").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  state.ahorros.push({
    id: uid(),
    nombre: f.nombre.value.trim(),
    objetivo: Number(f.objetivo.value),
    fechaObjetivo: f.fechaObjetivo.value || null,
    ambito: f.ambito.value,
    nota: f.nota.value.trim(),
    movimientos: [],
    creadoPor: sessionUserId,
    creadoEn: Date.now(),
  });
  save();
  f.reset();
  preparaFormAhorro();
  renderAhorros();
  renderInicio();
  toast("Objetivo creado");
});

function ahorroAcumulado(a) {
  return (a.movimientos || []).reduce((acc, m) => acc + (Number(m.importe) || 0), 0);
}

function renderAhorros() {
  const wrap = $("#lista-ahorros");
  const ahorrosVisibles = ahorrosDelModo();
  if (!ahorrosVisibles.length) {
    wrap.innerHTML = `<div class="card muted">Aún no hay objetivos de ahorro ${_modoApp === "personal" ? "personales" : "compartidos"}.</div>`;
    return;
  }
  wrap.innerHTML = ahorrosVisibles.map((a) => {
    const acum = ahorroAcumulado(a);
    const pct = a.objetivo > 0 ? Math.min(100, Math.round((acum / a.objetivo) * 100)) : 0;
    const ambitoLbl = a.ambito === "compartido" ? "Compartido" : `Personal · ${escape(nombreMiembro(a.ambito))}`;
    const movs = (a.movimientos || []).slice().sort((x, y) => (y.fecha || "").localeCompare(x.fecha || ""));
    return `<div class="card ahorro-card" data-id="${escape(a.id)}">
      <div class="ahorro-head">
        <h3>${escape(a.nombre)}</h3>
        <span class="badge">${ambitoLbl}</span>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="ahorro-cifras">
        <strong>${fmtMoney(acum)}</strong> <span class="muted">de ${fmtMoney(a.objetivo)}</span>
        <span class="muted small">· ${pct}%${a.fechaObjetivo ? ` · meta ${fmtFecha(a.fechaObjetivo)}` : ""}</span>
      </div>
      ${a.nota ? `<p class="muted small">${escape(a.nota)}</p>` : ""}
      <form class="form-row mov-form" data-mov="${escape(a.id)}">
        <input name="fecha" type="date" value="${hoyISO()}" required />
        <input name="importe" type="number" step="0.01" placeholder="Importe €" required />
        <select name="miembro">${state.miembros.map((m) => `<option value="${escape(m.id)}" ${m.id === sessionUserId ? "selected" : ""}>${escape(m.nombre)}</option>`).join("")}</select>
        <input name="nota" placeholder="Nota" />
        <button type="submit">+ Aportar</button>
      </form>
      <details>
        <summary>Movimientos (${movs.length})</summary>
        <table class="tabla compact">
          <thead><tr><th>Fecha</th><th>Quién</th><th class="num">Importe</th><th>Nota</th><th></th></tr></thead>
          <tbody>${movs.map((mv) => `
            <tr>
              <td>${fmtFecha(mv.fecha)}</td>
              <td>${escape(nombreMiembro(mv.miembro))}</td>
              <td class="num">${fmtMoney(mv.importe)}</td>
              <td>${escape(mv.nota || "")}</td>
              <td><button class="link danger" data-del-mov="${escape(a.id)}|${escape(mv.id)}">×</button></td>
            </tr>`).join("") || `<tr><td colspan="5" class="muted center">Sin movimientos</td></tr>`}</tbody>
        </table>
      </details>
      <div class="form-row">
        <button class="ghost danger" data-del-ahorro="${escape(a.id)}">Eliminar objetivo</button>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll(".mov-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = form.dataset.mov;
      const a = state.ahorros.find((x) => x.id === id);
      if (!a) return;
      a.movimientos = a.movimientos || [];
      a.movimientos.push({
        id: uid(),
        fecha: form.fecha.value,
        importe: Number(form.importe.value),
        miembro: form.miembro.value,
        nota: form.nota.value.trim(),
        creadoEn: Date.now(),
      });
      save();
      renderAhorros();
      renderInicio();
      toast("Aportación guardada");
    });
  });

  wrap.querySelectorAll("[data-del-mov]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar este movimiento?")) return;
      const [aid, mid] = b.dataset.delMov.split("|");
      const a = state.ahorros.find((x) => x.id === aid);
      if (!a) return;
      a.movimientos = (a.movimientos || []).filter((m) => m.id !== mid);
      save(); renderAhorros(); renderInicio();
    });
  });

  wrap.querySelectorAll("[data-del-ahorro]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar este objetivo y todos sus movimientos?")) return;
      state.ahorros = state.ahorros.filter((x) => x.id !== b.dataset.delAhorro);
      save(); renderAhorros(); renderInicio();
    });
  });
}

// ============================================================
// INVERSIONES
// ============================================================
function preparaFormInversion() {
  const f = $("#form-inversion");
  f.fecha.value = hoyISO();
  if (_modoApp === "comun") {
    $("#sel-inv-ambito").innerHTML = `<option value="compartido">Compartida (pareja)</option>`;
  } else {
    const yo = getMiembro(_miembroActivoId);
    $("#sel-inv-ambito").innerHTML = yo ? `<option value="${escape(yo.id)}" selected>Personal de ${escape(yo.nombre)}</option>` : "";
  }
}

$("#form-inversion").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  state.inversiones.push({
    id: uid(),
    nombre: f.nombre.value.trim(),
    tipo: f.tipo.value,
    invertido: Number(f.invertido.value),
    valorActual: f.valorActual.value === "" ? null : Number(f.valorActual.value),
    fecha: f.fecha.value,
    ambito: f.ambito.value,
    notas: f.notas.value.trim(),
    proyectada: f.proyectada.checked,
    creadoPor: sessionUserId,
    creadoEn: Date.now(),
  });
  save();
  f.reset();
  preparaFormInversion();
  renderInversiones();
  toast("Inversión añadida");
});

function renderInversiones() {
  const visibles = inversionesDelModo();
  const activas = visibles.filter((i) => !i.proyectada);
  const proy = visibles.filter((i) => i.proyectada);
  let totalInv = 0, totalValor = 0;
  $("#tabla-inversiones").innerHTML = activas.length ? activas.map((i) => {
    const valor = i.valorActual ?? i.invertido;
    const diff = valor - i.invertido;
    totalInv += i.invertido; totalValor += valor;
    const ambitoLbl = i.ambito === "compartido" ? "Compartida" : `Personal · ${escape(nombreMiembro(i.ambito))}`;
    return `<tr>
      <td>${escape(i.nombre)}${i.notas ? `<div class="muted small">${escape(i.notas)}</div>` : ""}</td>
      <td>${escape(i.tipo || "")}</td>
      <td><span class="badge">${ambitoLbl}</span></td>
      <td class="num">${fmtMoney(i.invertido)}</td>
      <td class="num">${fmtMoney(valor)}</td>
      <td class="num ${diff >= 0 ? "pos" : "neg"}">${diff >= 0 ? "+" : ""}${fmtMoney(diff)}</td>
      <td>${fmtFecha(i.fecha)}</td>
      <td class="acciones">
        <button class="link" data-edit-inv="${escape(i.id)}">Actualizar valor</button>
        <button class="link danger" data-del-inv="${escape(i.id)}">×</button>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="8" class="muted center">Sin inversiones</td></tr>`;

  $("#tabla-inversiones-proy").innerHTML = proy.length ? proy.map((i) => {
    const ambitoLbl = i.ambito === "compartido" ? "Compartida" : `Personal · ${escape(nombreMiembro(i.ambito))}`;
    return `<tr>
      <td>${escape(i.nombre)}${i.notas ? `<div class="muted small">${escape(i.notas)}</div>` : ""}</td>
      <td>${escape(i.tipo || "")}</td>
      <td><span class="badge">${ambitoLbl}</span></td>
      <td class="num">${fmtMoney(i.invertido)}</td>
      <td>${fmtFecha(i.fecha)}</td>
      <td class="acciones">
        <button class="link" data-promover-inv="${escape(i.id)}">Marcar realizada</button>
        <button class="link danger" data-del-inv="${escape(i.id)}">×</button>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="muted center">Sin planificadas</td></tr>`;

  $("#kpi-inv-invertido").textContent = fmtMoney(totalInv);
  $("#kpi-inv-valor").textContent = fmtMoney(totalValor);
  const rend = totalValor - totalInv;
  const rEl = $("#kpi-inv-rend");
  rEl.textContent = (rend >= 0 ? "+" : "") + fmtMoney(rend);
  rEl.classList.toggle("pos", rend >= 0);
  rEl.classList.toggle("neg", rend < 0);

  document.querySelectorAll("[data-del-inv]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar esta inversión?")) return;
      state.inversiones = state.inversiones.filter((x) => x.id !== b.dataset.delInv);
      save(); renderInversiones();
    });
  });
  document.querySelectorAll("[data-edit-inv]").forEach((b) => {
    b.addEventListener("click", () => {
      const inv = state.inversiones.find((x) => x.id === b.dataset.editInv);
      if (!inv) return;
      const v = window.prompt(`Valor actual de "${inv.nombre}" (en ${moneda()}):`, inv.valorActual ?? inv.invertido);
      if (v === null) return;
      const n = Number(v);
      if (isNaN(n) || n < 0) { toast("Valor inválido"); return; }
      inv.valorActual = n;
      save(); renderInversiones();
    });
  });
  document.querySelectorAll("[data-promover-inv]").forEach((b) => {
    b.addEventListener("click", () => {
      const inv = state.inversiones.find((x) => x.id === b.dataset.promoverInv);
      if (!inv) return;
      inv.proyectada = false;
      inv.fecha = hoyISO();
      save(); renderInversiones();
    });
  });
}

// ============================================================
// CUADRE
// ============================================================
function calcularCuadre() {
  // Para cada gasto compartido: a cada miembro le toca reparto%
  // Quien pagó adelantó al resto su parte.
  // Saldo[m] = (lo que pagó) - (lo que le tocaba)
  // Más liquidaciones: si X pagó a Y → saldo[X] += imp, saldo[Y] -= imp
  const saldos = {};
  state.miembros.forEach((m) => { saldos[m.id] = 0; });
  state.gastos.forEach((g) => {
    if (g.tipo !== "compartido") return;
    const imp = Number(g.importe) || 0;
    const r = g.reparto || {};
    saldos[g.pagadoPor] = (saldos[g.pagadoPor] || 0) + imp;
    Object.entries(r).forEach(([mid, pct]) => {
      saldos[mid] = (saldos[mid] || 0) - imp * (Number(pct) / 100);
    });
  });
  (state.liquidaciones || []).forEach((l) => {
    const imp = Number(l.importe) || 0;
    saldos[l.de] = (saldos[l.de] || 0) + imp;
    saldos[l.a] = (saldos[l.a] || 0) - imp;
  });
  return saldos;
}

function transferenciasNecesarias(saldos) {
  // Algoritmo simple para 2 personas (que es nuestro caso típico)
  // pero generalizable: deudores → acreedores
  const arr = Object.entries(saldos).map(([id, v]) => ({ id, v: Math.round(v * 100) / 100 }));
  const deudores = arr.filter((x) => x.v < -0.005).sort((a, b) => a.v - b.v);
  const acreed = arr.filter((x) => x.v > 0.005).sort((a, b) => b.v - a.v);
  const trans = [];
  let i = 0, j = 0;
  while (i < deudores.length && j < acreed.length) {
    const monto = Math.min(-deudores[i].v, acreed[j].v);
    trans.push({ de: deudores[i].id, a: acreed[j].id, importe: monto });
    deudores[i].v += monto;
    acreed[j].v -= monto;
    if (Math.abs(deudores[i].v) < 0.005) i++;
    if (acreed[j].v < 0.005) j++;
  }
  return trans;
}

function renderCuadre() {
  const saldos = calcularCuadre();
  const trans = transferenciasNecesarias(saldos);
  const det = $("#cuadre-detalle");
  const resumen = $("#cuadre-resumen");

  const filasSaldos = state.miembros.map((m) => {
    const v = saldos[m.id] || 0;
    const cls = v > 0.005 ? "pos" : v < -0.005 ? "neg" : "";
    const txt = v > 0.005 ? `Le deben ${fmtMoney(v)}` : v < -0.005 ? `Debe ${fmtMoney(-v)}` : "Al día";
    return `<tr><td><span class="chip" style="--c:${escape(m.color)}">${escape(m.nombre)}</span></td><td class="${cls}">${txt}</td></tr>`;
  }).join("");

  const filasTrans = trans.length ? trans.map((t) => `
    <li><strong>${escape(nombreMiembro(t.de))}</strong> → <strong>${escape(nombreMiembro(t.a))}</strong>: ${fmtMoney(t.importe)}</li>
  `).join("") : `<li class="muted">Todo cuadrado ✓</li>`;

  det.innerHTML = `
    <table class="tabla compact"><tbody>${filasSaldos}</tbody></table>
    <h3>Para saldar la deuda:</h3>
    <ul class="trans-list">${filasTrans}</ul>
  `;

  resumen.innerHTML = trans.length
    ? `<ul class="trans-list compact">${trans.map((t) => `<li><strong>${escape(nombreMiembro(t.de))}</strong> debe <strong>${fmtMoney(t.importe)}</strong> a <strong>${escape(nombreMiembro(t.a))}</strong></li>`).join("")}</ul>`
    : `<p class="muted">Todo cuadrado ✓</p>`;

  // Selects liquidación + tabla
  $("#liq-de").innerHTML = state.miembros.map((m) => `<option value="${escape(m.id)}">${escape(m.nombre)}</option>`).join("");
  $("#liq-a").innerHTML = state.miembros.map((m, idx) => `<option value="${escape(m.id)}" ${idx === 1 ? "selected" : ""}>${escape(m.nombre)}</option>`).join("");
  const tb = $("#tabla-liquidaciones");
  const liqs = (state.liquidaciones || []).slice().sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  tb.innerHTML = liqs.length ? liqs.map((l) => `
    <tr>
      <td>${fmtFecha(l.fecha)}</td>
      <td>${escape(nombreMiembro(l.de))}</td>
      <td>${escape(nombreMiembro(l.a))}</td>
      <td class="num">${fmtMoney(l.importe)}</td>
      <td>${escape(l.nota || "")}</td>
      <td><button class="link danger" data-del-liq="${escape(l.id)}">×</button></td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="muted center">Sin liquidaciones</td></tr>`;
  tb.querySelectorAll("[data-del-liq]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar esta liquidación?")) return;
      state.liquidaciones = state.liquidaciones.filter((x) => x.id !== b.dataset.delLiq);
      save(); renderCuadre(); renderInicio();
    });
  });

  // Fecha por defecto en form liquidación
  const fl = $("#form-liquidacion");
  if (fl && !fl.fecha.value) fl.fecha.value = hoyISO();
}

$("#form-liquidacion").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.de.value === f.a.value) { toast("De y A deben ser distintos"); return; }
  state.liquidaciones = state.liquidaciones || [];
  state.liquidaciones.push({
    id: uid(),
    fecha: f.fecha.value,
    de: f.de.value,
    a: f.a.value,
    importe: Number(f.importe.value),
    nota: f.nota.value.trim(),
    creadoPor: sessionUserId,
    creadoEn: Date.now(),
  });
  save();
  f.reset();
  f.fecha.value = hoyISO();
  renderCuadre();
  renderInicio();
  toast("Liquidación registrada");
});

// ============================================================
// PROPUESTAS
// ============================================================
$("#form-propuesta").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  state.propuestas.push({
    id: uid(),
    titulo: f.titulo.value.trim(),
    descripcion: f.descripcion.value.trim(),
    importe: f.importe.value ? Number(f.importe.value) : null,
    miembro: sessionUserId,
    fecha: hoyISO(),
    estado: "abierta", // abierta | aceptada | rechazada
    votos: {},
    comentarios: [],
    creadoEn: Date.now(),
  });
  save();
  f.reset();
  renderPropuestas();
  toast("Propuesta publicada");
});

function renderPropuestas() {
  const abiertas = state.propuestas.filter((p) => p.estado === "abierta");
  const cerradas = state.propuestas.filter((p) => p.estado !== "abierta");
  $("#lista-propuestas").innerHTML = abiertas.length ? abiertas.map(propuestaHTML).join("") : `<p class="muted">No hay propuestas activas.</p>`;
  $("#lista-propuestas-cerradas").innerHTML = cerradas.length ? cerradas.map(propuestaHTML).join("") : `<p class="muted">No hay cerradas.</p>`;
  enlazarPropuestaHandlers();
}

function propuestaHTML(p) {
  const yo = sessionUserId;
  const miVoto = (p.votos || {})[yo];
  const votos = Object.values(p.votos || {});
  const okVotos = votos.filter((v) => v === "ok").length;
  const noVotos = votos.filter((v) => v === "no").length;
  const m = getMiembro(p.miembro);
  return `<div class="prop-card ${p.estado}" data-id="${escape(p.id)}">
    <div class="prop-head">
      <span class="chip" style="--c:${escape(m?.color || "#888")}">${escape(m?.nombre || "?")}</span>
      <strong>${escape(p.titulo)}</strong>
      ${p.importe ? `<span class="badge">${fmtMoney(p.importe)}</span>` : ""}
      <span class="muted small">${fmtFecha(p.fecha)}</span>
      ${p.estado !== "abierta" ? `<span class="badge badge-${p.estado}">${p.estado}</span>` : ""}
    </div>
    ${p.descripcion ? `<p class="prop-desc">${escape(p.descripcion)}</p>` : ""}
    <div class="prop-votos">
      <button class="vote ${miVoto === "ok" ? "active" : ""}" data-vote="${escape(p.id)}|ok">👍 ${okVotos}</button>
      <button class="vote ${miVoto === "no" ? "active" : ""}" data-vote="${escape(p.id)}|no">👎 ${noVotos}</button>
      ${p.estado === "abierta" ? `
        <button class="ghost small" data-cerrar="${escape(p.id)}|aceptada">Aceptar</button>
        <button class="ghost small" data-cerrar="${escape(p.id)}|rechazada">Rechazar</button>
      ` : `<button class="ghost small" data-reabrir="${escape(p.id)}">Reabrir</button>`}
      <button class="link danger small" data-del-prop="${escape(p.id)}">Eliminar</button>
    </div>
    <div class="prop-coms">
      ${(p.comentarios || []).map((c) => `
        <div class="prop-com"><span class="chip" style="--c:${escape(getMiembro(c.miembro)?.color || "#888")}">${escape(nombreMiembro(c.miembro))}</span>
          <span>${escape(c.texto)}</span>
          <span class="muted small">${fmtFecha(c.fecha)}</span>
        </div>
      `).join("")}
      <form class="form-row prop-com-form" data-com="${escape(p.id)}">
        <input name="texto" placeholder="Comentar…" required />
        <button type="submit">Enviar</button>
      </form>
    </div>
  </div>`;
}

function enlazarPropuestaHandlers() {
  document.querySelectorAll("[data-vote]").forEach((b) => {
    b.addEventListener("click", () => {
      const [pid, v] = b.dataset.vote.split("|");
      const p = state.propuestas.find((x) => x.id === pid);
      if (!p) return;
      p.votos = p.votos || {};
      p.votos[sessionUserId] = p.votos[sessionUserId] === v ? null : v;
      if (!p.votos[sessionUserId]) delete p.votos[sessionUserId];
      save(); renderPropuestas();
    });
  });
  document.querySelectorAll("[data-cerrar]").forEach((b) => {
    b.addEventListener("click", () => {
      const [pid, estado] = b.dataset.cerrar.split("|");
      const p = state.propuestas.find((x) => x.id === pid);
      if (!p) return;
      p.estado = estado;
      save(); renderPropuestas();
    });
  });
  document.querySelectorAll("[data-reabrir]").forEach((b) => {
    b.addEventListener("click", () => {
      const p = state.propuestas.find((x) => x.id === b.dataset.reabrir);
      if (!p) return;
      p.estado = "abierta";
      save(); renderPropuestas();
    });
  });
  document.querySelectorAll("[data-del-prop]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirmar("¿Eliminar esta propuesta?")) return;
      state.propuestas = state.propuestas.filter((x) => x.id !== b.dataset.delProp);
      save(); renderPropuestas();
    });
  });
  document.querySelectorAll(".prop-com-form").forEach((f) => {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const p = state.propuestas.find((x) => x.id === f.dataset.com);
      if (!p) return;
      p.comentarios = p.comentarios || [];
      p.comentarios.push({
        id: uid(),
        miembro: sessionUserId,
        texto: f.texto.value.trim(),
        fecha: hoyISO(),
        creadoEn: Date.now(),
      });
      save(); renderPropuestas();
    });
  });
}

// ============================================================
// INICIO (resumen)
// ============================================================
function renderInicio() {
  const mes = mesActualISO();
  const ingMes = ingresosDelModo().filter((i) => mesISO(i.fecha) === mes);
  const gasMes = gastosDelModo().filter((g) => mesISO(g.fecha) === mes);
  const ingTotal = ingMes.reduce((a, b) => a + (Number(b.importe) || 0), 0);
  const gasTotal = gasMes.reduce((a, b) => a + (Number(b.importe) || 0), 0);
  $("#kpi-ingresos-mes").textContent = fmtMoney(ingTotal);
  $("#kpi-gastos-mes").textContent = fmtMoney(gasTotal);
  const bal = ingTotal - gasTotal;
  const balEl = $("#kpi-balance-mes");
  balEl.textContent = fmtMoney(bal);
  balEl.classList.toggle("pos", bal >= 0);
  balEl.classList.toggle("neg", bal < 0);

  const ahorrado = ahorrosDelModo().reduce((acc, a) => acc + ahorroAcumulado(a), 0);
  $("#kpi-ahorrado").textContent = fmtMoney(ahorrado);

  // Mis números
  const yo = userActual();
  $("#kpi-yo-nombre").textContent = yo ? `· ${yo.nombre}` : "";
  const yoIng = ingMes.filter((i) => i.miembro === sessionUserId).reduce((a, b) => a + (Number(b.importe) || 0), 0);
  const yoGasPers = gasMes.filter((g) => g.tipo === "personal" && g.pagadoPor === sessionUserId)
    .reduce((a, b) => a + (Number(b.importe) || 0), 0);
  const yoGasComp = gasMes.filter((g) => g.tipo === "compartido")
    .reduce((a, b) => a + (Number(b.importe) || 0) * ((b.reparto?.[sessionUserId] || 0) / 100), 0);
  $("#kpi-yo-ing").textContent = fmtMoney(yoIng);
  $("#kpi-yo-gas").textContent = fmtMoney(yoGasPers);
  $("#kpi-yo-comp").textContent = fmtMoney(yoGasComp);
  const saldoYo = yoIng - yoGasPers - yoGasComp;
  const sEl = $("#kpi-yo-saldo");
  sEl.textContent = fmtMoney(saldoYo);
  sEl.classList.toggle("pos", saldoYo >= 0);
  sEl.classList.toggle("neg", saldoYo < 0);

  // Cuadre resumen
  const saldos = calcularCuadre();
  const trans = transferenciasNecesarias(saldos);
  $("#cuadre-resumen").innerHTML = trans.length
    ? `<ul class="trans-list compact">${trans.map((t) => `<li><strong>${escape(nombreMiembro(t.de))}</strong> debe <strong>${fmtMoney(t.importe)}</strong> a <strong>${escape(nombreMiembro(t.a))}</strong></li>`).join("")}</ul>`
    : `<p class="muted">Todo cuadrado ✓</p>`;

  // Últimos gastos
  const recientes = gastosDelModo().slice().sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, 6);
  $("#lista-ultimos-gastos").innerHTML = recientes.length ? recientes.map((g) => `
    <div class="row-item">
      <span class="chip" style="--c:${escape(getMiembro(g.pagadoPor)?.color || "#888")}">${escape(nombreMiembro(g.pagadoPor))}</span>
      <span class="grow">
        <strong>${escape(g.descripcion)}</strong>
        <span class="muted small"> · ${escape(g.categoria || "")} · ${fmtFecha(g.fecha)}</span>
      </span>
      <span class="num">${fmtMoney(g.importe)}</span>
    </div>
  `).join("") : `<p class="muted">Sin movimientos.</p>`;

  // Ahorros en inicio
  const ahorrosListados = ahorrosDelModo();
  $("#lista-ahorros-inicio").innerHTML = ahorrosListados.length ? ahorrosListados.slice(0, 4).map((a) => {
    const acum = ahorroAcumulado(a);
    const pct = a.objetivo > 0 ? Math.min(100, Math.round((acum / a.objetivo) * 100)) : 0;
    return `<div class="row-item col">
      <div><strong>${escape(a.nombre)}</strong> <span class="muted small">${fmtMoney(acum)} / ${fmtMoney(a.objetivo)}</span></div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
    </div>`;
  }).join("") : `<p class="muted">Sin objetivos aún.</p>`;
}

// ============================================================
// AJUSTES
// ============================================================
function renderRepartoDefault() {
  const wrap = $("#reparto-default-inputs");
  if (!wrap) return;
  const ms = state.miembros || [];
  if (!ms.length) { wrap.innerHTML = ""; return; }
  const rConfig = state.hogar?.repartoDefault || {};
  const equitativo = Math.round(100 / ms.length);
  wrap.innerHTML = ms.map((m) => {
    const val = rConfig[m.id] != null ? rConfig[m.id] : equitativo;
    return `<div class="rep-row">
      <span class="rep-name" style="--c:${escape(m.color)}">${escape(m.nombre)}</span>
      <input type="number" min="0" max="100" step="1" data-mid="${escape(m.id)}" value="${val}" class="rep-default-input" />
      <span>%</span>
    </div>`;
  }).join("") + `<div class="rep-row" style="border-top:1px solid var(--line); padding-top:6px;"><span class="rep-name muted">Total</span><strong id="rep-default-suma" style="margin-right:34px">100 %</strong></div>`;
  const inputs = wrap.querySelectorAll(".rep-default-input");
  const sumEl = $("#rep-default-suma");
  const recalcular = () => {
    const suma = Array.from(inputs).reduce((a, inp) => a + (Number(inp.value) || 0), 0);
    sumEl.textContent = suma + " %";
    sumEl.style.color = suma === 100 ? "var(--pos)" : "var(--neg)";
  };
  inputs.forEach((inp) => inp.addEventListener("input", recalcular));
  recalcular();
}

const _formRepartoDefault = $("#form-reparto-default");
if (_formRepartoDefault) {
  _formRepartoDefault.addEventListener("submit", (e) => {
    e.preventDefault();
    const r = {};
    let total = 0;
    document.querySelectorAll(".rep-default-input").forEach((inp) => {
      const v = Math.max(0, Math.min(100, Number(inp.value) || 0));
      r[inp.dataset.mid] = v;
      total += v;
    });
    if (total !== 100) { toast("La suma debe ser exactamente 100%"); return; }
    if (!state.hogar) state.hogar = {};
    state.hogar.repartoDefault = r;
    save();
    toast("Reparto guardado");
  });
}

$("#form-hogar").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  state.hogar.nombre = f.nombre.value.trim() || state.hogar.nombre;
  state.hogar.moneda = f.moneda.value;
  save();
  $("#brand-sub").textContent = state.hogar.nombre;
  renderAll();
  toast("Hogar actualizado");
});

function renderMiembros() {
  const tb = $("#tabla-miembros");
  tb.innerHTML = state.miembros.map((m) => `
    <tr data-id="${escape(m.id)}">
      <td><input class="inp-nombre" value="${escape(m.nombre)}" /></td>
      <td><input class="inp-color" type="color" value="${escape(m.color)}" /></td>
      <td><button class="ghost small" data-pin="${escape(m.id)}">Cambiar PIN</button></td>
      <td class="acciones">
        <button class="link" data-save-m="${escape(m.id)}">Guardar</button>
      </td>
    </tr>
  `).join("");
  tb.querySelectorAll("[data-save-m]").forEach((b) => {
    b.addEventListener("click", () => {
      const tr = b.closest("tr");
      const m = getMiembro(b.dataset.saveM);
      if (!m) return;
      m.nombre = tr.querySelector(".inp-nombre").value.trim() || m.nombre;
      m.color = tr.querySelector(".inp-color").value;
      save();
      renderAll();
      toast("Miembro actualizado");
    });
  });
  tb.querySelectorAll("[data-pin]").forEach((b) => {
    b.addEventListener("click", async () => {
      const m = getMiembro(b.dataset.pin);
      if (!m) return;
      const nuevo = window.prompt(`Nuevo PIN de 4 dígitos para ${m.nombre}:`, "");
      if (nuevo === null) return;
      if (!/^\d{4}$/.test(nuevo)) { toast("PIN debe tener 4 dígitos"); return; }
      m.pinHash = await hashPin(m.id, nuevo);
      save();
      toast("PIN actualizado");
    });
  });
}

function renderCategorias() {
  // Gastos: lista jerárquica con sub-categorías
  const wrap = $("#cat-gastos-list");
  if (wrap) {
    wrap.innerHTML = state.catGastos.map((c, idx) => `
      <div class="cat-block" data-cat="${escape(c.cat)}">
        <div class="cat-head">
          <strong>${escape(c.cat)}</strong>
          <div class="cat-actions">
            <button class="link" data-ren-cat="${escape(c.cat)}">Renombrar</button>
            <button class="link danger" data-del-cat="${escape(c.cat)}">Eliminar</button>
          </div>
        </div>
        <div class="chips">
          ${(c.subs || []).map((s) => `<span class="chip">${escape(s)}<button data-del-sub="${escape(c.cat)}|${escape(s)}" class="x" title="Eliminar">×</button></span>`).join("")}
        </div>
        <form class="form-row sub-form" data-add-sub="${escape(c.cat)}">
          <input name="sub" required placeholder="Nueva subcategoría de ${escape(c.cat)}" />
          <button type="submit" class="ghost small">+ Subcategoría</button>
        </form>
      </div>
    `).join("");

    wrap.querySelectorAll("[data-del-cat]").forEach((b) => b.addEventListener("click", () => {
      const cat = b.dataset.delCat;
      if (!confirmar(`¿Eliminar la categoría "${cat}" y todas sus subcategorías?`)) return;
      state.catGastos = state.catGastos.filter((c) => c.cat !== cat);
      save(); renderCategorias(); preparaFormGasto();
    }));
    wrap.querySelectorAll("[data-ren-cat]").forEach((b) => b.addEventListener("click", () => {
      const cat = b.dataset.renCat;
      const nuevo = window.prompt("Nuevo nombre para la categoría:", cat);
      if (!nuevo || nuevo.trim() === "" || nuevo === cat) return;
      const item = state.catGastos.find((c) => c.cat === cat);
      if (!item) return;
      item.cat = nuevo.trim();
      // Renombrar también en gastos existentes
      state.gastos.forEach((g) => { if (g.categoria === cat) g.categoria = nuevo.trim(); });
      save(); renderCategorias(); preparaFormGasto(); renderGastos();
    }));
    wrap.querySelectorAll("[data-del-sub]").forEach((b) => b.addEventListener("click", () => {
      const [cat, sub] = b.dataset.delSub.split("|");
      const item = state.catGastos.find((c) => c.cat === cat);
      if (!item) return;
      item.subs = (item.subs || []).filter((s) => s !== sub);
      save(); renderCategorias(); preparaFormGasto();
    }));
    wrap.querySelectorAll(".sub-form").forEach((f) => {
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        const cat = f.dataset.addSub;
        const sub = f.sub.value.trim();
        if (!sub) return;
        const item = state.catGastos.find((c) => c.cat === cat);
        if (!item) return;
        item.subs = item.subs || [];
        if (!item.subs.includes(sub)) item.subs.push(sub);
        save(); f.reset();
        renderCategorias(); preparaFormGasto();
      });
    });
  }

  // Ingresos: chips planos
  const ciw = $("#chips-cat-ingreso");
  if (ciw) {
    ciw.innerHTML = state.catIngresos.map((c) => `<span class="chip">${escape(c)}<button data-del-cati="${escape(c)}" class="x">×</button></span>`).join("");
    ciw.querySelectorAll("[data-del-cati]").forEach((b) => b.addEventListener("click", () => {
      state.catIngresos = state.catIngresos.filter((c) => c !== b.dataset.delCati);
      save(); renderCategorias(); preparaFormIngreso();
    }));
  }
}

$("#form-cat-gasto").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = e.target.cat.value.trim();
  if (!v) return;
  if (!state.catGastos.find((c) => c.cat === v)) {
    state.catGastos.push({ cat: v, subs: [] });
  }
  save(); e.target.reset();
  renderCategorias(); preparaFormGasto();
});
$("#form-cat-ingreso").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = e.target.cat.value.trim();
  if (v && !state.catIngresos.includes(v)) state.catIngresos.push(v);
  save(); e.target.reset();
  renderCategorias(); preparaFormIngreso();
});

// Sync UI
const inpSyncCode = $("#sync-code");
const inpSyncMaster = $("#sync-master");
const chkSyncAuto = $("#chk-sync-auto");
if ($("#btn-sync-save-key")) {
  $("#btn-sync-save-key").addEventListener("click", () => {
    syncMasterKey = inpSyncMaster.value.trim();
    localStorage.setItem(SYNC_KEY_KEY, syncMasterKey);
    if (syncAuto && syncCodeOk()) autoSyncAlCargar();
    toast("Master Key guardada");
  });
}
$("#btn-sync-save-code").addEventListener("click", () => {
  syncCode = inpSyncCode.value.trim();
  localStorage.setItem(SYNC_CODE_KEY, syncCode);
  if (syncAuto && syncCodeOk()) autoSyncAlCargar();
  toast("Sync code guardado");
});
chkSyncAuto.addEventListener("change", () => {
  syncAuto = chkSyncAuto.checked;
  localStorage.setItem(SYNC_AUTO_KEY, syncAuto ? "1" : "0");
  if (syncAuto) { autoSyncAlCargar(); arrancarPollSync(); }
  else actualizarSyncStatus("Auto-sync desactivada");
});
$("#btn-sync-push").addEventListener("click", () => pushToCloud(false));
$("#btn-sync-pull").addEventListener("click", () => pullFromCloud(false));

$("#btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gastos-casa-${hoyISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#file-import").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (!confirmar("¿Reemplazar los datos actuales por los del archivo?")) return;
  try {
    const txt = await f.text();
    const data = JSON.parse(txt);
    state = migrarCategorias({ ...defaultData(), ...data });
    save();
    renderAll();
    toast("Importado");
  } catch (err) {
    toast("Archivo inválido: " + err.message);
  }
  e.target.value = "";
});
$("#btn-reset").addEventListener("click", () => {
  if (!confirmar("¿Borrar TODOS los datos locales? (No toca la nube)")) return;
  // Cancelar cualquier push pendiente y NO subir el estado vacío al bin remoto
  clearTimeout(_pushTimer);
  state = defaultData();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  renderAll();
  toast("Datos locales borrados (la nube se mantiene)");
});

const _btnReclasificar = $("#btn-reclasificar-importados");
if (_btnReclasificar) {
  _btnReclasificar.addEventListener("click", () => {
    const candidatos = state.gastos.filter((g) => g.tipo === "compartido" && (g.nota || "").toLowerCase().includes("importado"));
    if (!candidatos.length) {
      toast("No hay gastos importados marcados como compartidos");
      return;
    }
    if (!confirmar(`Hay ${candidatos.length} gastos importados marcados como compartidos.\n\n¿Pasarlos todos a gastos personales (al miembro que pagó)?`)) return;
    candidatos.forEach((g) => {
      g.tipo = "personal";
      g.reparto = repartoTodoPara(g.pagadoPor);
    });
    save();
    renderAll();
    toast(`${candidatos.length} gastos pasados a personales`);
  });
}

const _btnResetGastos = $("#btn-reset-gastos");
if (_btnResetGastos) {
  _btnResetGastos.addEventListener("click", () => {
    if (!confirmar(`¿Borrar TODOS los gastos del hogar "${state.hogar.nombre}"?\n\nMantiene miembros, ingresos, ahorros, categorías y configuración.`)) return;
    state.gastos = [];
    state.liquidaciones = []; // cuadre asociado pierde sentido
    save();
    renderAll();
    toast("Gastos borrados");
  });
}
const _btnResetIngresos = $("#btn-reset-ingresos");
if (_btnResetIngresos) {
  _btnResetIngresos.addEventListener("click", () => {
    if (!confirmar(`¿Borrar TODOS los ingresos del hogar "${state.hogar.nombre}"?`)) return;
    state.ingresos = [];
    save();
    renderAll();
    toast("Ingresos borrados");
  });
}
const _btnResetAhorros = $("#btn-reset-ahorros");
if (_btnResetAhorros) {
  _btnResetAhorros.addEventListener("click", () => {
    if (!confirmar(`¿Borrar TODOS los objetivos de ahorro del hogar "${state.hogar.nombre}"?`)) return;
    state.ahorros = [];
    save();
    renderAll();
    toast("Ahorros borrados");
  });
}

// ============================================================
// IMPORTAR EXCEL BANCARIO
// ============================================================
let _importData = null; // { wb, sheetName, rows, headers, rowsFiltradas }
let _xlsxLoading = null;

async function ensureXlsx() {
  if (window.XLSX) return;
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("No se pudo cargar el lector de Excel"));
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

function detectarColumna(headers, patterns) {
  for (const h of headers) {
    const lh = (h || "").toString().toLowerCase();
    if (patterns.some((p) => lh.includes(p))) return h;
  }
  return "";
}

function parseFechaCelda(v) {
  if (!v && v !== 0) return "";
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    // Excel serial date (días desde 1900-01-00)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const s = v.toString().trim();
  // dd/mm/yyyy o dd-mm-yyyy o dd.mm.yyyy
  let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // yyyy-mm-dd o yyyy/mm/dd
  m = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // Try Date.parse fallback
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

function parseImporte(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  let s = v.toString().trim();
  // Negativo entre paréntesis (formato contable): (123,45) → -123.45
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  // Detectar signo al final (ej. "123,45-")
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ""); }
  // Quitar moneda y espacios
  s = s.replace(/[€$£\s]/g, "");
  // Formato europeo 1.234,56 o americano 1,234.56
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

function rellenarMappings(headers) {
  const opciones = `<option value=""></option>` + headers.map((h) => `<option>${escape(h)}</option>`).join("");
  ["map-fecha", "map-concepto", "map-importe", "map-importe-pos"].forEach((id) => {
    const el = $("#" + id);
    if (el) el.innerHTML = opciones;
  });
  $("#map-fecha").value = detectarColumna(headers, ["fecha", "date", "f.operacion", "f.valor"]);
  $("#map-concepto").value = detectarColumna(headers, ["concepto", "descripcion", "descripción", "descrip", "detalle", "asunto", "operacion", "operación", "narrative", "movimiento"]);
  $("#map-importe").value = detectarColumna(headers, ["importe", "amount", "monto", "valor"]);
  // Si hay columnas separadas débito/crédito
  if (!$("#map-importe").value) {
    $("#map-importe").value = detectarColumna(headers, ["debito", "débito", "debit", "cargo", "salida"]);
  }
  $("#map-importe-pos").value = detectarColumna(headers, ["credito", "crédito", "credit", "abono", "entrada", "haber"]);
}

function rellenarSelectsImport() {
  const sm = $("#imp-miembro");
  // Al importar desde la zona personal, fijar al miembro activo (sin opción de cambiar)
  const yo = getMiembro(_miembroActivoId) || getMiembro(sessionUserId);
  if (yo) {
    sm.innerHTML = `<option value="${escape(yo.id)}" selected>${escape(yo.nombre)}</option>`;
  } else {
    sm.innerHTML = state.miembros.map((m) => `<option value="${escape(m.id)}">${escape(m.nombre)}</option>`).join("");
  }
  const sc = $("#imp-cat");
  sc.innerHTML = state.catGastos.map((c) => `<option>${escape(c.cat)}</option>`).join("");
  const sub = $("#imp-subcat");
  const actualizarSub = () => {
    const subs = getSubsDe(sc.value);
    sub.innerHTML = subs.length ? subs.map((s) => `<option>${escape(s)}</option>`).join("") : `<option value="">—</option>`;
  };
  sc.onchange = actualizarSub;
  actualizarSub();
}

function claveMov(fecha, descripcion, importe) {
  return `${fecha}|${(descripcion || "").slice(0, 30).toLowerCase().trim()}|${Math.abs(Number(importe) || 0).toFixed(2)}`;
}
function indiceExistentes() {
  // Map: clave → { tipo: "gasto"|"ingreso", id, fecha, descripcion, importe }
  const idx = new Map();
  state.gastos.forEach((g) => {
    const k = claveMov(g.fecha, g.descripcion, g.importe);
    if (!idx.has(k)) idx.set(k, { tipo: "gasto", id: g.id, fecha: g.fecha, descripcion: g.descripcion, importe: Number(g.importe) || 0 });
  });
  state.ingresos.forEach((g) => {
    const k = claveMov(g.fecha, g.descripcion, g.importe);
    if (!idx.has(k)) idx.set(k, { tipo: "ingreso", id: g.id, fecha: g.fecha, descripcion: g.descripcion, importe: Number(g.importe) || 0 });
  });
  return idx;
}

function renderPreviewImport() {
  if (!_importData) return;
  const fechaCol = $("#map-fecha").value;
  const conceptoCol = $("#map-concepto").value;
  const importeCol = $("#map-importe").value;
  const importePosCol = $("#map-importe-pos").value;
  const desde = $("#imp-desde").value;
  const hasta = $("#imp-hasta").value;
  const skipDup = $("#imp-skip-dup").checked;

  const body = $("#imp-preview-body");
  if (!fechaCol || !conceptoCol || (!importeCol && !importePosCol)) {
    body.innerHTML = `<tr><td colspan="6" class="muted center">Selecciona al menos Fecha, Concepto e Importe.</td></tr>`;
    $("#imp-counter").textContent = "";
    return;
  }

  const existing = indiceExistentes();
  const soloDup = $("#imp-solo-dup") && $("#imp-solo-dup").checked;

  const parsed = _importData.rows.map((r, idx) => {
    let imp = 0;
    if (importeCol && importePosCol) {
      const debito = parseImporte(r[importeCol]);
      const credito = parseImporte(r[importePosCol]);
      // Si las columnas vienen como valores absolutos: débito - crédito invertido
      if (debito !== 0 && credito === 0) imp = -Math.abs(debito);
      else if (credito !== 0 && debito === 0) imp = Math.abs(credito);
      else imp = credito - Math.abs(debito);
    } else if (importeCol) {
      imp = parseImporte(r[importeCol]);
    } else {
      imp = parseImporte(r[importePosCol]);
    }
    return {
      idx,
      fecha: parseFechaCelda(r[fechaCol]),
      concepto: (r[conceptoCol] || "").toString().trim(),
      importe: imp,
    };
  }).filter((x) => x.fecha && (x.concepto || x.importe !== 0));

  const filtered = parsed.filter((x) => {
    if (desde && x.fecha < desde) return false;
    if (hasta && x.fecha > hasta) return false;
    if (!x.importe) return false;
    return true;
  });

  _importData.rowsFiltradas = filtered.map((x) => {
    const key = claveMov(x.fecha, x.concepto, x.importe);
    const choca = existing.get(key) || null;
    return {
      ...x,
      tipo: x.importe < 0 ? "gasto" : "ingreso",
      duplicado: !!choca,
      conflicto: choca,
      key,
    };
  });

  const total = _importData.rowsFiltradas.length;
  const gastos = _importData.rowsFiltradas.filter((x) => x.tipo === "gasto").length;
  const ingresos = total - gastos;
  const dupTotal = _importData.rowsFiltradas.filter((x) => x.duplicado).length;
  $("#imp-counter").textContent = `· ${total} mov. · ${gastos} gastos · ${ingresos} ingresos${dupTotal ? " · " + dupTotal + " posibles duplicados" : ""}`;

  const aviso = $("#imp-dup-aviso");
  if (aviso) {
    if (dupTotal > 0) {
      aviso.hidden = false;
      $("#imp-dup-aviso-detalle").textContent = ` ${dupTotal} de ${total} movimientos ya parecen registrados. Revisa cada uno y elige una acción (por defecto se omiten).`;
    } else {
      aviso.hidden = true;
    }
  }

  const catDef = $("#imp-cat") ? $("#imp-cat").value : "";
  const subDef = $("#imp-subcat") ? $("#imp-subcat").value : "";

  // Inicializar overrides por fila si no existen
  if (!_importData.overrides) _importData.overrides = {};
  if (!_importData.dupAction) _importData.dupAction = {};
  const overridesPrevios = _importData.overrides;
  const dupActionPrev = _importData.dupAction;

  const filasMostradas = soloDup
    ? _importData.rowsFiltradas.filter((x) => x.duplicado)
    : _importData.rowsFiltradas;

  body.innerHTML = filasMostradas.slice(0, 250).map((x) => {
    const accionDup = dupActionPrev[x.idx] || (skipDup ? "omitir" : "duplicar");
    let checked = "checked";
    if (x.duplicado && accionDup === "omitir") checked = "";
    const ov = overridesPrevios[x.idx] || {};
    const catFila = ov.cat || catDef;
    const subFila = ov.sub != null ? ov.sub : subDef;
    const subsCat = getSubsDe(catFila);
    const estadoCell = x.duplicado
      ? `<div class="dup-estado">
          <span class="badge badge-dup">Duplicado</span>
          <div class="muted xsmall">Choca con ${x.conflicto.tipo} del ${fmtFecha(x.conflicto.fecha)} · ${escape((x.conflicto.descripcion || "").slice(0, 36))} · ${fmtMoney(x.conflicto.importe)}</div>
          <select class="imp-dup-action" data-idx="${x.idx}">
            <option value="omitir" ${accionDup === "omitir" ? "selected" : ""}>Omitir (no importar)</option>
            <option value="duplicar" ${accionDup === "duplicar" ? "selected" : ""}>Importar igualmente</option>
            <option value="reemplazar" ${accionDup === "reemplazar" ? "selected" : ""}>Reemplazar el existente</option>
          </select>
        </div>`
      : "";
    return `<tr class="${x.duplicado ? "dup dup-action-" + accionDup : ""}">
      <td><input type="checkbox" class="imp-check" data-i="${x.idx}" ${checked} /></td>
      <td>${fmtFecha(x.fecha)}</td>
      <td>${escape(x.concepto)}</td>
      <td class="num ${x.importe < 0 ? "neg" : "pos"}">${fmtMoney(x.importe)}</td>
      <td><span class="badge ${x.tipo === "gasto" ? "badge-rechazada" : "badge-aceptada"}">${x.tipo === "gasto" ? "Gasto" : "Ingreso"}</span></td>
      <td class="imp-cat-cell">
        <select class="imp-row-cat" data-idx="${x.idx}">
          ${state.catGastos.map((c) => `<option ${c.cat === catFila ? "selected" : ""}>${escape(c.cat)}</option>`).join("")}
        </select>
        <select class="imp-row-sub" data-idx="${x.idx}">
          ${subsCat.length ? subsCat.map((s) => `<option ${s === subFila ? "selected" : ""}>${escape(s)}</option>`).join("") : `<option value="">—</option>`}
        </select>
      </td>
      <td>${estadoCell}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="muted center">${soloDup ? "No hay duplicados." : "No hay movimientos para importar con estos filtros."}</td></tr>`;
  if (filasMostradas.length > 250) {
    body.innerHTML += `<tr><td colspan="7" class="muted center small">+ ${filasMostradas.length - 250} más usan la categoría por defecto</td></tr>`;
  }

  // Listeners para cambios por fila
  body.querySelectorAll(".imp-row-cat").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = sel.dataset.idx;
      const subSel = body.querySelector(`.imp-row-sub[data-idx="${idx}"]`);
      const subs = getSubsDe(sel.value);
      subSel.innerHTML = subs.length ? subs.map((s) => `<option>${escape(s)}</option>`).join("") : `<option value="">—</option>`;
      _importData.overrides[idx] = { cat: sel.value, sub: subSel.value || "" };
    });
  });
  body.querySelectorAll(".imp-row-sub").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = sel.dataset.idx;
      const catSel = body.querySelector(`.imp-row-cat[data-idx="${idx}"]`);
      _importData.overrides[idx] = { cat: catSel.value, sub: sel.value };
    });
  });
  body.querySelectorAll(".imp-dup-action").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = sel.dataset.idx;
      _importData.dupAction[idx] = sel.value;
      const check = body.querySelector(`.imp-check[data-i="${idx}"]`);
      if (check) check.checked = sel.value !== "omitir";
      const tr = sel.closest("tr");
      if (tr) {
        tr.classList.remove("dup-action-omitir", "dup-action-duplicar", "dup-action-reemplazar");
        tr.classList.add("dup-action-" + sel.value);
      }
    });
  });
}

function activarPaso2Import() {
  $("#import-paso-1").classList.add("hidden");
  $("#import-paso-2").classList.remove("hidden");
}

function cerrarImport() {
  _importData = null;
  $("#import-paso-1").classList.remove("hidden");
  $("#import-paso-2").classList.add("hidden");
  $("#file-import-banco").value = "";
  $("#import-fname").textContent = "";
  $("#imp-preview-body").innerHTML = "";
  $("#import-sheet-picker").innerHTML = "";
}

function cargarHoja(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  // Detectar la primera fila con varias celdas (a veces hay cabeceras de banco arriba)
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  let headerRow = 0;
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const filled = raw[i].filter((c) => c !== "" && c != null).length;
    if (filled >= 3) { headerRow = i; break; }
  }
  // Construir filas usando headerRow como encabezado
  const headers = raw[headerRow].map((h, i) => (h || "").toString().trim() || `col${i + 1}`);
  const rows = [];
  for (let i = headerRow + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.every((c) => c === "" || c == null)) continue;
    const obj = {};
    headers.forEach((h, j) => { obj[h] = r[j] ?? ""; });
    rows.push(obj);
  }
  if (!rows.length) {
    toast("La hoja parece vacía");
    return;
  }
  _importData = { wb, sheetName, rows, headers };
  rellenarMappings(headers);
  rellenarSelectsImport();
  renderPreviewImport();
}

async function manejarArchivoBanco(file) {
  await ensureXlsx();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetNames = wb.SheetNames || [];
  const picker = $("#import-sheet-picker");
  if (sheetNames.length > 1) {
    picker.innerHTML = `
      <div class="form-row">
        <label>
          <span>Hoja del Excel</span>
          <select id="sheet-sel">${sheetNames.map((s) => `<option>${escape(s)}</option>`).join("")}</select>
        </label>
      </div>`;
    picker.querySelector("#sheet-sel").addEventListener("change", (e) => cargarHoja(wb, e.target.value));
  } else {
    picker.innerHTML = "";
  }
  cargarHoja(wb, sheetNames[0]);
  activarPaso2Import();
}

function ejecutarImport() {
  if (!_importData || !_importData.rowsFiltradas) return;
  const miembro = $("#imp-miembro").value;
  const tipoGasto = $("#imp-tipo").value;
  const catDef = $("#imp-cat").value;
  const subDef = $("#imp-subcat").value;
  const skipDup = $("#imp-skip-dup").checked;
  const visiblesChecked = new Set(
    $$(".imp-check").filter((c) => c.checked).map((c) => parseInt(c.dataset.i, 10))
  );
  const visiblesEnDom = new Set(
    $$(".imp-check").map((c) => parseInt(c.dataset.i, 10))
  );
  let nGastos = 0, nIngresos = 0, nDupOmit = 0, nReemplazos = 0;
  const overrides = _importData.overrides || {};
  const dupActions = _importData.dupAction || {};
  _importData.rowsFiltradas.forEach((x) => {
    const enDom = visiblesEnDom.has(x.idx);
    const checked = visiblesChecked.has(x.idx);

    if (x.duplicado) {
      const accion = dupActions[x.idx] || (skipDup ? "omitir" : "duplicar");
      if (accion === "omitir") { nDupOmit++; return; }
      if (enDom && !checked) { nDupOmit++; return; }
      if (accion === "reemplazar" && x.conflicto) {
        if (x.conflicto.tipo === "gasto") {
          state.gastos = state.gastos.filter((g) => g.id !== x.conflicto.id);
        } else {
          state.ingresos = state.ingresos.filter((g) => g.id !== x.conflicto.id);
        }
        nReemplazos++;
      }
    } else {
      // Filas no-duplicadas: si están en el DOM, respetar checkbox del usuario.
      // Si están filtradas fuera (modo "solo duplicados"), importar por defecto.
      if (enDom && !checked) return;
    }

    const ov = overrides[x.idx];
    const catFinal = (ov && ov.cat) || catDef;
    const subFinal = (ov && ov.sub != null) ? ov.sub : subDef;

    if (x.tipo === "gasto") {
      state.gastos.push({
        id: uid(),
        fecha: x.fecha,
        descripcion: x.concepto,
        importe: Math.abs(x.importe),
        tipo: tipoGasto,
        categoria: catFinal,
        subcategoria: subFinal,
        pagadoPor: miembro,
        reparto: (tipoGasto === "personal" || (tipoGasto === "inesperado" && _modoApp === "personal")) ? repartoTodoPara(miembro) : repartoPorDefecto(),
        nota: "Importado del banco",
        creadoPor: sessionUserId,
        creadoEn: Date.now(),
      });
      nGastos++;
    } else {
      state.ingresos.push({
        id: uid(),
        fecha: x.fecha,
        descripcion: x.concepto,
        importe: Math.abs(x.importe),
        tipo: _modoApp === "comun" ? "compartido" : "personal",
        categoria: catFinal,
        miembro,
        recurrente: false,
        nota: "Importado del banco",
        creadoPor: sessionUserId,
        creadoEn: Date.now(),
      });
      nIngresos++;
    }
  });
  save();
  cerrarImport();
  renderAll();
  const partes = [`Importados: ${nGastos} gastos, ${nIngresos} ingresos`];
  if (nReemplazos) partes.push(`${nReemplazos} reemplazados`);
  if (nDupOmit) partes.push(`${nDupOmit} duplicados omitidos`);
  toast(partes.join(" · "));
}

// Listeners de importación
$("#file-import-banco").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  $("#import-fname").textContent = f.name;
  try {
    toast("Leyendo archivo…");
    await manejarArchivoBanco(f);
  } catch (err) {
    toast("Error al leer: " + err.message);
    console.error(err);
  }
});

["map-fecha", "map-concepto", "map-importe", "map-importe-pos", "imp-desde", "imp-hasta", "imp-skip-dup", "imp-solo-dup"].forEach((id) => {
  document.addEventListener("change", (e) => { if (e.target.id === id) renderPreviewImport(); });
});

$("#btn-imp-cancel").addEventListener("click", cerrarImport);
$("#btn-imp-do").addEventListener("click", ejecutarImport);
$("#imp-toggle-all").addEventListener("change", (e) => {
  $$(".imp-check").forEach((c) => { c.checked = e.target.checked; });
});

// ============================================================
// CUENTAS (pestaña)
// ============================================================
function renderCuentas() {
  const cs = cuentasDelModo();
  $("#cuentas-subtitulo").textContent = _modoApp === "comun" ? "· del hogar" : `· de ${nombreMiembro(_miembroActivoId)}`;

  const lista = $("#lista-cuentas");
  if (lista) {
    lista.innerHTML = cs.length ? cs.map((c) => {
      const saldo = saldoCuenta(c.id);
      const tipoLbl = { banco: "Banco", efectivo: "Efectivo", tarjeta: "Tarjeta", ahorro: "Ahorro", otra: "Otra" }[c.tipo] || "Cuenta";
      return `<div class="cuenta-card" style="--c:${escape(c.color || '#7a4ec5')}">
        <div class="cuenta-head">
          <div>
            <strong>${escape(c.nombre)}</strong>
            <span class="muted small">${escape(tipoLbl)}</span>
          </div>
          <button class="link danger small" data-archivar-cuenta="${escape(c.id)}" title="Archivar">×</button>
        </div>
        <div class="cuenta-saldo ${saldo < 0 ? "neg" : ""}">${fmtMoney(saldo)}</div>
        ${c.notas ? `<p class="muted small">${escape(c.notas)}</p>` : ""}
        <div class="cuenta-meta">
          <span class="muted small">Saldo inicial ${fmtMoney(c.saldoInicial || 0)}${c.fechaInicial ? ` · ${fmtFecha(c.fechaInicial)}` : ""}</span>
        </div>
      </div>`;
    }).join("") : `<p class="muted">Aún no hay cuentas ${_modoApp === "comun" ? "del hogar" : "personales"}. Crea una abajo.</p>`;

    lista.querySelectorAll("[data-archivar-cuenta]").forEach((b) => {
      b.addEventListener("click", () => {
        const c = state.cuentas.find((x) => x.id === b.dataset.archivarCuenta);
        if (!c) return;
        if (!confirmar(`Archivar la cuenta "${c.nombre}"?\n\nDesaparece del listado pero los movimientos asociados se mantienen.`)) return;
        c.archivada = true;
        save();
        renderCuentas();
      });
    });
  }

  // Selectores de transferencia
  const desde = $("#trans-desde");
  const hacia = $("#trans-hacia");
  if (desde && hacia) {
    const optsCs = cs.map((c) => `<option value="${escape(c.id)}">${escape(c.nombre)} (${fmtMoney(saldoCuenta(c.id))})</option>`).join("");
    desde.innerHTML = optsCs;
    // El destino puede ser cualquiera del mismo ámbito + cuentas comunes (si estamos en personal) o personales del miembro registro (si estamos en común)
    let optsHacia = optsCs;
    if (_modoApp === "personal") {
      const comunes = cuentasComunes();
      if (comunes.length) {
        optsHacia += `<optgroup label="Cuentas comunes del hogar">` + comunes.map((c) => `<option value="${escape(c.id)}">${escape(c.nombre)} · común</option>`).join("") + `</optgroup>`;
      }
    } else if (_modoApp === "comun") {
      const personales = (state.cuentas || []).filter((c) => c.ambito !== "compartido" && !c.archivada);
      if (personales.length) {
        optsHacia += `<optgroup label="Cuentas personales">` + personales.map((c) => `<option value="${escape(c.id)}">${escape(c.nombre)} · ${escape(nombreMiembro(c.ambito))}</option>`).join("") + `</optgroup>`;
      }
    }
    hacia.innerHTML = optsHacia;
  }

  // Fecha por defecto en form transferencia
  const ft = $("#form-transferencia");
  if (ft && !ft.fecha.value) ft.fecha.value = hoyISO();

  // Lista de transferencias visibles (las que afectan a cuentas del modo)
  const tb = $("#lista-trans");
  if (tb) {
    const cIds = new Set(cs.map((c) => c.id));
    const trans = (state.transferencias || [])
      .filter((t) => cIds.has(t.desdeCuenta) || cIds.has(t.haciaCuenta))
      .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))
      .slice(0, 30);
    tb.innerHTML = trans.length ? trans.map((t) => `
      <div class="row-item">
        <span class="grow">
          <strong>${escape(nombreCuenta(t.desdeCuenta))}</strong>
          <span class="muted small">→</span>
          <strong>${escape(nombreCuenta(t.haciaCuenta))}</strong>
          <span class="muted small"> · ${fmtFecha(t.fecha)}${t.nota ? ` · ${escape(t.nota)}` : ""}</span>
        </span>
        <span class="num">${fmtMoney(t.importe)}</span>
        <button class="link danger small" data-del-trans="${escape(t.id)}" title="Eliminar">×</button>
      </div>
    `).join("") : `<p class="muted">Sin transferencias.</p>`;
    tb.querySelectorAll("[data-del-trans]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!confirmar("¿Eliminar esta transferencia?")) return;
        state.transferencias = (state.transferencias || []).filter((x) => x.id !== b.dataset.delTrans);
        save();
        renderCuentas();
      });
    });
  }
}

const _formCuenta = $("#form-cuenta");
if (_formCuenta) {
  _formCuenta.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    if (!state.cuentas) state.cuentas = [];
    state.cuentas.push({
      id: uid(),
      nombre: f.nombre.value.trim(),
      tipo: f.tipo.value,
      ambito: _modoApp === "comun" ? "compartido" : _miembroActivoId,
      saldoInicial: Number(f.saldoInicial.value) || 0,
      fechaInicial: f.fechaInicial.value || hoyISO(),
      color: f.color.value || "#7a4ec5",
      notas: f.notas.value.trim(),
      archivada: false,
      creadoPor: sessionUserId,
      creadoEn: Date.now(),
    });
    save();
    f.reset();
    f.color.value = "#7a4ec5";
    renderCuentas();
    toast("Cuenta creada");
  });
}

const _formTransferencia = $("#form-transferencia");
if (_formTransferencia) {
  _formTransferencia.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.desde.value === f.hacia.value) { toast("Las cuentas deben ser distintas"); return; }
    if (!state.transferencias) state.transferencias = [];
    state.transferencias.push({
      id: uid(),
      fecha: f.fecha.value,
      desdeCuenta: f.desde.value,
      haciaCuenta: f.hacia.value,
      importe: Number(f.importe.value),
      nota: f.nota.value.trim(),
      miembro: _miembroActivoId,
      creadoPor: sessionUserId,
      creadoEn: Date.now(),
    });
    save();
    f.reset();
    f.fecha.value = hoyISO();
    renderCuentas();
    toast("Transferencia registrada");
  });
}

// ============================================================
// OBJETIVOS (pestaña)
// ============================================================
function ensureObjetivos() {
  if (!state.objetivos) state.objetivos = { gastoMes: 0, ahorroMes: 0, porSubcategoria: {} };
  if (!state.objetivos.porSubcategoria) state.objetivos.porSubcategoria = {};

  // Migración suave: si había objetivos por categoría (versión anterior),
  // los movemos a la primera subcategoría de cada categoría para no perder el dato.
  if (state.objetivos.porCategoria && Object.keys(state.objetivos.porCategoria).length) {
    Object.entries(state.objetivos.porCategoria).forEach(([cat, val]) => {
      const v = Number(val) || 0;
      if (v <= 0) return;
      const item = state.catGastos.find((c) => c.cat === cat);
      const firstSub = item && item.subs && item.subs.length ? item.subs[0] : null;
      if (firstSub) {
        state.objetivos.porSubcategoria[cat] = state.objetivos.porSubcategoria[cat] || {};
        if (!state.objetivos.porSubcategoria[cat][firstSub]) {
          state.objetivos.porSubcategoria[cat][firstSub] = v;
        }
      }
    });
    delete state.objetivos.porCategoria;
  }
}

function objSumaCat(cat) {
  const subs = state.objetivos.porSubcategoria?.[cat] || {};
  return Object.values(subs).reduce((a, b) => a + (Number(b) || 0), 0);
}

function objSumaTotal() {
  const por = state.objetivos.porSubcategoria || {};
  let total = 0;
  Object.values(por).forEach((subs) => {
    Object.values(subs).forEach((v) => { total += Number(v) || 0; });
  });
  return total;
}

function renderObjetivos() {
  ensureObjetivos();
  const f = $("#form-obj-mes");
  if (f) {
    f.gastoMes.value = state.objetivos.gastoMes || "";
    f.ahorroMes.value = state.objetivos.ahorroMes || "";
  }

  const tb = $("#tabla-obj-cats");
  if (!tb) { actualizarSumaObjetivos(); return; }

  // Construimos secciones por categoría con sus subcategorías como filas
  const filas = [];
  state.catGastos.forEach((c) => {
    const subsArr = c.subs && c.subs.length ? c.subs : [c.cat]; // si no tiene subs, usa el propio nombre como fila
    const sumaCatId = `suma-cat-${escape(c.cat).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    // Cabecera de categoría
    filas.push(`
      <tr class="obj-cat-head">
        <th colspan="1">${escape(c.cat)}</th>
        <th class="num"><span class="muted small">Total:</span> <span class="obj-cat-suma" id="${sumaCatId}" data-cat-suma="${escape(c.cat)}">${fmtMoney(objSumaCat(c.cat))}</span></th>
      </tr>
    `);
    // Filas de subcategoría
    subsArr.forEach((sub) => {
      const v = state.objetivos.porSubcategoria?.[c.cat]?.[sub] ?? "";
      filas.push(`
        <tr class="obj-sub-row">
          <td><span class="obj-sub-name">${escape(sub)}</span></td>
          <td class="num"><input type="number" min="0" step="1" data-obj-cat="${escape(c.cat)}" data-obj-sub="${escape(sub)}" value="${v}" placeholder="—" class="obj-cat-input" /></td>
        </tr>
      `);
    });
  });
  tb.innerHTML = filas.join("");

  tb.querySelectorAll(".obj-cat-input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const cat = inp.dataset.objCat;
      const sub = inp.dataset.objSub;
      const val = inp.value === "" ? null : Number(inp.value);
      state.objetivos.porSubcategoria[cat] = state.objetivos.porSubcategoria[cat] || {};
      if (val == null || isNaN(val) || val <= 0) {
        delete state.objetivos.porSubcategoria[cat][sub];
        if (!Object.keys(state.objetivos.porSubcategoria[cat]).length) delete state.objetivos.porSubcategoria[cat];
      } else {
        state.objetivos.porSubcategoria[cat][sub] = val;
      }
      save();
      // Actualizar solo la suma de la categoría y la suma total (sin re-render completo)
      const sumaEl = Array.from(tb.querySelectorAll("[data-cat-suma]")).find((el) => el.dataset.catSuma === cat);
      if (sumaEl) sumaEl.textContent = fmtMoney(objSumaCat(cat));
      actualizarSumaObjetivos();
    });
  });

  actualizarSumaObjetivos();
}

function actualizarSumaObjetivos() {
  ensureObjetivos();
  const el = $("#obj-suma");
  if (el) el.textContent = fmtMoney(objSumaTotal());
}

const _formObjMes = $("#form-obj-mes");
if (_formObjMes) {
  _formObjMes.addEventListener("submit", (e) => {
    e.preventDefault();
    ensureObjetivos();
    state.objetivos.gastoMes = Number(e.target.gastoMes.value) || 0;
    state.objetivos.ahorroMes = Number(e.target.ahorroMes.value) || 0;
    save();
    toast("Objetivos guardados");
  });
}

// ============================================================
// SEGUIMIENTO (pestaña)
// ============================================================
let _chartJsLoading = null;
async function ensureChartJs() {
  if (window.Chart) return;
  if (_chartJsLoading) return _chartJsLoading;
  _chartJsLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("No se pudo cargar Chart.js"));
    document.head.appendChild(s);
  });
  return _chartJsLoading;
}

// Helpers de fechas mensuales
function listaMesesDesdeHasta(desdeISO, hastaISO) {
  // Devuelve array de "YYYY-MM" inclusivo
  const out = [];
  const [yd, md] = desdeISO.split("-").map(Number);
  const [yh, mh] = hastaISO.split("-").map(Number);
  let y = yd, m = md;
  while (y < yh || (y === yh && m <= mh)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
function mesAnterior(mesISO, n = 1) {
  const [y, m] = mesISO.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}
function nombreMesISO(mesISO) {
  const [y, m] = mesISO.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("es-ES", { month: "short", year: "2-digit" }).replace(".", "");
}

// Devuelve "YYYY-MM" del primer gasto/ingreso registrado, o mes actual
function primerMesConDatos() {
  const fechas = [
    ...state.gastos.map((g) => g.fecha),
    ...state.ingresos.map((g) => g.fecha),
  ].filter(Boolean);
  if (!fechas.length) return mesActualISO();
  fechas.sort();
  return fechas[0].slice(0, 7);
}

function rangoSeguimiento() {
  const sel = $("#seg-rango") ? $("#seg-rango").value : "12";
  const ahora = mesActualISO();
  if (sel === "all") return listaMesesDesdeHasta(primerMesConDatos(), ahora);
  const n = parseInt(sel, 10);
  return listaMesesDesdeHasta(mesAnterior(ahora, n - 1), ahora);
}

// Filtra y agrega gastos del mes según filtros activos y vista
function gastoMes(mesISO, filtros) {
  let arr = state.gastos.filter((g) => mesISO === mesISO_es(g.fecha));
  if (filtros.tipo && filtros.tipo !== "todos") arr = arr.filter((g) => g.tipo === filtros.tipo);
  if (filtros.categoria) arr = arr.filter((g) => g.categoria === filtros.categoria);
  if (filtros.miembro) arr = arr.filter((g) => g.pagadoPor === filtros.miembro);
  return arr.reduce((a, g) => a + (Number(g.importe) || 0), 0);
}
function mesISO_es(iso) { return (iso || "").slice(0, 7); }

function ingresoMes(mesISO, filtros = {}) {
  let arr = state.ingresos.filter((g) => mesISO === mesISO_es(g.fecha));
  if (filtros.miembro) arr = arr.filter((g) => g.miembro === filtros.miembro);
  return arr.reduce((a, g) => a + (Number(g.importe) || 0), 0);
}

function gastoMesPorCategoria(mesISO, filtros) {
  let arr = state.gastos.filter((g) => mesISO === mesISO_es(g.fecha));
  if (filtros.tipo && filtros.tipo !== "todos") arr = arr.filter((g) => g.tipo === filtros.tipo);
  if (filtros.miembro) arr = arr.filter((g) => g.pagadoPor === filtros.miembro);
  const map = {};
  arr.forEach((g) => {
    const c = g.categoria || "Sin categoría";
    map[c] = (map[c] || 0) + (Number(g.importe) || 0);
  });
  return map;
}

function gastoMesPorSubcategoria(mesISO, filtros = {}) {
  // Devuelve { categoria: { subcategoria: total } }
  let arr = state.gastos.filter((g) => mesISO === mesISO_es(g.fecha));
  if (filtros.tipo && filtros.tipo !== "todos") arr = arr.filter((g) => g.tipo === filtros.tipo);
  if (filtros.miembro) arr = arr.filter((g) => g.pagadoPor === filtros.miembro);
  const map = {};
  arr.forEach((g) => {
    const c = g.categoria || "Sin categoría";
    const s = g.subcategoria || "—";
    map[c] = map[c] || {};
    map[c][s] = (map[c][s] || 0) + (Number(g.importe) || 0);
  });
  return map;
}

function ahorroMesReal(mesISO) {
  // Suma de movimientos positivos de objetivos de ahorro en el mes
  let total = 0;
  state.ahorros.forEach((a) => {
    (a.movimientos || []).forEach((mv) => {
      if (mesISO_es(mv.fecha) === mesISO) total += Number(mv.importe) || 0;
    });
  });
  return total;
}

function leerFiltrosSeg() {
  const vistaSel = $("#seg-vista") ? $("#seg-vista").value : "total";
  // El Seguimiento es siempre de gastos compartidos (del hogar)
  const filtros = { tipo: "compartido" };
  if (vistaSel.startsWith("cat:")) filtros.categoria = vistaSel.slice(4);
  else if (vistaSel.startsWith("mbr:")) filtros.miembro = vistaSel.slice(4);
  return { filtros, vistaSel };
}

function tituloVista(vistaSel, filtros) {
  const partes = [];
  if (vistaSel === "total") partes.push("Total");
  else if (vistaSel.startsWith("cat:")) partes.push("Categoría: " + vistaSel.slice(4));
  else if (vistaSel.startsWith("mbr:")) partes.push("Miembro: " + nombreMiembro(vistaSel.slice(4)));
  if (filtros.tipo && filtros.tipo !== "todos") {
    partes.push(filtros.tipo === "compartido" ? "compartidos" : filtros.tipo === "personal" ? "personales" : "inesperados");
  }
  return "· " + partes.join(" · ");
}

let _chartEvo = null;
let _chartObj = null;
let _segActivo = false;

function prepararSelectoresSeg() {
  // Vista: rellenar optgroups con cats y miembros
  const og1 = $("#seg-vista-cats");
  const og2 = $("#seg-vista-miembros");
  if (og1) og1.innerHTML = state.catGastos.map((c) => `<option value="cat:${escape(c.cat)}">${escape(c.cat)}</option>`).join("");
  if (og2) og2.innerHTML = state.miembros.map((m) => `<option value="mbr:${escape(m.id)}">${escape(m.nombre)}</option>`).join("");
}

function prepararSelectorMesObj() {
  const sel = $("#seg-obj-mes");
  if (!sel) return;
  const meses = listaMesesDesdeHasta(primerMesConDatos(), mesActualISO()).reverse(); // más recientes primero
  const ahora = mesActualISO();
  const actual = sel.value;
  sel.innerHTML = meses.map((m) => {
    const label = nombreMesISO(m) + (m === ahora ? " (en curso)" : "");
    return `<option value="${m}" ${m === actual ? "selected" : ""}>${label}</option>`;
  }).join("");
  if (!sel.value && meses.length) sel.value = ahora;
}

async function renderSeguimiento() {
  if (!_segActivo) return; // solo render cuando la pestaña está visible
  try {
    await ensureChartJs();
  } catch (err) {
    toast("Error cargando gráficos: " + err.message);
    return;
  }
  prepararSelectoresSeg();
  prepararSelectorMesObj();
  renderChartEvo();
  renderChartObj();
}

function renderChartEvo() {
  if (!window.Chart) return;
  const { filtros, vistaSel } = leerFiltrosSeg();
  const meses = rangoSeguimiento();
  const labels = meses.map(nombreMesISO);
  const data = meses.map((m) => gastoMes(m, filtros));
  const mostrarIngresos = $("#seg-ingresos") && $("#seg-ingresos").checked;
  const ingresos = mostrarIngresos
    ? meses.map((m) => ingresoMes(m, vistaSel.startsWith("mbr:") ? { miembro: vistaSel.slice(4) } : {}))
    : null;

  $("#seg-evo-titulo").textContent = tituloVista(vistaSel, filtros);

  const root = getComputedStyle(document.documentElement);
  const colorInk = root.getPropertyValue("--ink-soft").trim() || "#ddd";
  const colorMuted = root.getPropertyValue("--muted").trim() || "#888";
  const colorBrand = root.getPropertyValue("--brand").trim() || "#e4e5e9";
  const colorPos = root.getPropertyValue("--pos").trim() || "#6dd49e";
  const colorLine = root.getPropertyValue("--line-strong").trim() || "rgba(255,255,255,0.14)";

  const datasets = [{
    label: "Gasto",
    data,
    borderColor: colorBrand,
    backgroundColor: "rgba(228,229,233,0.12)",
    borderWidth: 2,
    tension: 0.3,
    pointRadius: 4,
    pointHoverRadius: 7,
    fill: true,
    pointBackgroundColor: meses.map((m) => m === mesActualISO() ? "transparent" : colorBrand),
    pointBorderColor: colorBrand,
    pointBorderWidth: 2,
  }];
  if (ingresos) {
    datasets.push({
      label: "Ingresos",
      data: ingresos,
      borderColor: colorPos,
      backgroundColor: "transparent",
      borderWidth: 2,
      borderDash: [4, 4],
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 6,
      fill: false,
    });
  }

  const cfg = {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: colorInk, font: { family: getComputedStyle(document.body).fontFamily } } },
        tooltip: {
          backgroundColor: "#1a1b1f",
          titleColor: "#f0f1f3",
          bodyColor: "#f0f1f3",
          borderColor: colorLine,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda()}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: colorMuted, font: { size: 11 } }, grid: { color: colorLine, drawBorder: false } },
        y: { ticks: { color: colorMuted, font: { size: 11 }, callback: (v) => v.toLocaleString("es-ES") }, grid: { color: colorLine, drawBorder: false } },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const mes = meses[idx];
        mostrarDetalleEvoMes(mes, filtros);
      },
    },
  };

  if (_chartEvo) _chartEvo.destroy();
  const ctx = $("#chart-evo");
  if (ctx) _chartEvo = new Chart(ctx, cfg);

  // Mensaje inicial
  const det = $("#seg-evo-detalle");
  if (det && !det.dataset.cargado) {
    det.innerHTML = `<p class="muted small">Pulsa un mes en el gráfico para ver el desglose por categoría frente a la media de los 3 meses anteriores.</p>`;
  }
}

function mostrarDetalleEvoMes(mesISO, filtros) {
  const det = $("#seg-evo-detalle");
  if (!det) return;
  det.dataset.cargado = "1";

  // En el desglose ignoramos el filtro de categoría (sino solo veríamos una fila),
  // pero respetamos tipo y miembro.
  const filtrosDesglose = { tipo: filtros.tipo, miembro: filtros.miembro };
  const catsActuales = gastoMesPorCategoria(mesISO, filtrosDesglose);

  // Media 3 meses anteriores
  const prev = [1, 2, 3].map((n) => mesAnterior(mesISO, n));
  const prevMaps = prev.map((m) => gastoMesPorCategoria(m, filtrosDesglose));
  const todasCats = new Set([
    ...Object.keys(catsActuales),
    ...prevMaps.flatMap((m) => Object.keys(m)),
  ]);
  const filas = Array.from(todasCats).map((cat) => {
    const real = catsActuales[cat] || 0;
    const medias = prevMaps.map((m) => m[cat] || 0);
    const media = medias.reduce((a, b) => a + b, 0) / medias.length;
    const diff = real - media;
    const pct = media > 0 ? (diff / media) * 100 : (real > 0 ? 100 : 0);
    return { cat, real, media, diff, pct };
  }).filter((f) => f.real !== 0 || f.media !== 0);

  // Ordenar por desviación absoluta
  filas.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const filasTop = filas.slice(0, 3).map((f) => f.cat);

  const totalReal = filas.reduce((a, b) => a + b.real, 0);
  const totalMedia = filas.reduce((a, b) => a + b.media, 0);
  const totalDiff = totalReal - totalMedia;
  const totalPct = totalMedia > 0 ? (totalDiff / totalMedia) * 100 : 0;

  const enCurso = mesISO === mesActualISO() ? ` <span class="badge">en curso</span>` : "";
  det.innerHTML = `
    <h3>Desglose ${escape(nombreMesISO(mesISO))}${enCurso} vs media 3 meses anteriores</h3>
    <table class="tabla compact seg-tabla">
      <thead><tr>
        <th>Categoría</th>
        <th class="num">Este mes</th>
        <th class="num">Media 3m</th>
        <th class="num">Δ €</th>
        <th class="num">Δ %</th>
      </tr></thead>
      <tbody>
        ${filas.length ? filas.map((f) => {
          const cls = f.diff > 0.005 ? "neg" : f.diff < -0.005 ? "pos" : "";
          const top = filasTop.includes(f.cat) ? " seg-top" : "";
          const arrow = f.diff > 0.005 ? "↑" : f.diff < -0.005 ? "↓" : "·";
          return `<tr class="${cls}${top}">
            <td>${escape(f.cat)}</td>
            <td class="num">${fmtMoney(f.real)}</td>
            <td class="num">${fmtMoney(f.media)}</td>
            <td class="num">${arrow} ${f.diff >= 0 ? "+" : ""}${fmtMoney(f.diff)}</td>
            <td class="num">${f.media > 0 ? (f.pct >= 0 ? "+" : "") + f.pct.toFixed(0) + "%" : "—"}</td>
          </tr>`;
        }).join("") : `<tr><td colspan="5" class="muted center">Sin datos</td></tr>`}
      </tbody>
      <tfoot>
        <tr>
          <th>Total</th>
          <th class="num">${fmtMoney(totalReal)}</th>
          <th class="num">${fmtMoney(totalMedia)}</th>
          <th class="num ${totalDiff > 0 ? "neg" : totalDiff < 0 ? "pos" : ""}">${totalDiff >= 0 ? "+" : ""}${fmtMoney(totalDiff)}</th>
          <th class="num">${totalMedia > 0 ? (totalPct >= 0 ? "+" : "") + totalPct.toFixed(0) + "%" : "—"}</th>
        </tr>
      </tfoot>
    </table>
  `;
}

function renderChartObj() {
  if (!window.Chart) return;
  ensureObjetivos();
  const modo = $("#seg-obj-modo") ? $("#seg-obj-modo").value : "gasto";
  const mes = $("#seg-obj-mes") ? $("#seg-obj-mes").value : mesActualISO();

  const root = getComputedStyle(document.documentElement);
  const colorInk = root.getPropertyValue("--ink-soft").trim() || "#ddd";
  const colorMuted = root.getPropertyValue("--muted").trim() || "#888";
  const colorBrand = root.getPropertyValue("--brand").trim() || "#e4e5e9";
  const colorPos = root.getPropertyValue("--pos").trim() || "#6dd49e";
  const colorNeg = root.getPropertyValue("--neg").trim() || "#f08a8a";
  const colorLine = root.getPropertyValue("--line-strong").trim() || "rgba(255,255,255,0.14)";

  let labels, dataObj, dataReal;
  if (modo === "ahorro") {
    labels = ["Ahorro mensual"];
    dataObj = [Number(state.objetivos.ahorroMes) || 0];
    dataReal = [ahorroMesReal(mes)];
  } else {
    // Gasto por categoría (solo compartidos)
    const realPorCat = gastoMesPorCategoria(mes, { tipo: "compartido" });
    const todasCats = new Set([
      ...Object.keys(state.objetivos.porSubcategoria || {}),
      ...Object.keys(realPorCat),
    ]);
    // Añadir "Total" como primera barra
    labels = ["Total", ...Array.from(todasCats)];
    const totalObj = Number(state.objetivos.gastoMes) || 0;
    const totalReal = Object.values(realPorCat).reduce((a, b) => a + b, 0);
    dataObj = [totalObj, ...labels.slice(1).map((c) => objSumaCat(c))];
    dataReal = [totalReal, ...labels.slice(1).map((c) => realPorCat[c] || 0)];
  }

  // Colores de barra real según si supera o no el objetivo
  const realColors = dataReal.map((v, i) => {
    const obj = dataObj[i];
    if (modo === "ahorro") {
      // Ahorro: real >= objetivo → bueno (verde); si no → rojo
      return v >= obj && obj > 0 ? colorPos : (obj === 0 ? colorBrand : colorNeg);
    } else {
      // Gasto: real <= objetivo → bueno (verde); pasarse → rojo; sin objetivo → neutro
      if (obj === 0) return colorBrand;
      return v <= obj ? colorPos : colorNeg;
    }
  });

  const cfg = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Objetivo",
          data: dataObj,
          backgroundColor: "rgba(228,229,233,0.22)",
          borderColor: colorMuted,
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: "Real",
          data: dataReal,
          backgroundColor: realColors,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: colorInk } },
        tooltip: {
          backgroundColor: "#1a1b1f",
          titleColor: "#f0f1f3",
          bodyColor: "#f0f1f3",
          borderColor: colorLine,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${moneda()}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: colorMuted, font: { size: 11 }, maxRotation: 40, minRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: colorMuted, font: { size: 11 }, callback: (v) => v.toLocaleString("es-ES") }, grid: { color: colorLine, drawBorder: false } },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const cat = labels[idx];
        mostrarDetalleObjCategoria(mes, modo, cat);
      },
    },
  };

  if (_chartObj) _chartObj.destroy();
  const ctx = $("#chart-obj");
  if (ctx) _chartObj = new Chart(ctx, cfg);

  // Tabla completa siempre visible debajo
  mostrarTablaObj(mes, modo);
}

function mostrarTablaObj(mesISO, modo) {
  const det = $("#seg-obj-detalle");
  if (!det) return;
  const enCurso = mesISO === mesActualISO() ? ` <span class="badge">en curso</span>` : "";

  if (modo === "ahorro") {
    const obj = Number(state.objetivos.ahorroMes) || 0;
    const real = ahorroMesReal(mesISO);
    const diff = real - obj;
    const pct = obj > 0 ? (diff / obj) * 100 : 0;
    const cls = diff >= 0 ? "pos" : "neg";
    det.innerHTML = `
      <h3>Ahorro ${escape(nombreMesISO(mesISO))}${enCurso}</h3>
      <table class="tabla compact seg-tabla">
        <thead><tr><th>Concepto</th><th class="num">Objetivo</th><th class="num">Real</th><th class="num">Δ €</th><th class="num">Δ %</th></tr></thead>
        <tbody>
          <tr class="${cls}">
            <td>Ahorro mensual</td>
            <td class="num">${fmtMoney(obj)}</td>
            <td class="num">${fmtMoney(real)}</td>
            <td class="num">${diff >= 0 ? "+" : ""}${fmtMoney(diff)}</td>
            <td class="num">${obj > 0 ? (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%" : "—"}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">Real = suma de aportaciones a objetivos de ahorro durante el mes.</p>
    `;
    return;
  }

  // Modo gasto: detalle agrupado por categoría con subcategorías como filas (solo compartidos)
  const realPorSub = gastoMesPorSubcategoria(mesISO, { tipo: "compartido" });
  const objSubMap = state.objetivos.porSubcategoria || {};

  // Construir lista de todas las categorías que tienen algo (objetivo o gasto real)
  const todasCats = new Set([...Object.keys(objSubMap), ...Object.keys(realPorSub)]);

  // Ordenar categorías por desviación absoluta total
  const catsOrdenadas = Array.from(todasCats).map((cat) => {
    const objCat = objSumaCat(cat);
    const realCat = Object.values(realPorSub[cat] || {}).reduce((a, b) => a + b, 0);
    const diffCat = realCat - objCat;
    return { cat, objCat, realCat, diffCat };
  }).sort((a, b) => Math.abs(b.diffCat) - Math.abs(a.diffCat));

  let filasHTML = "";
  catsOrdenadas.forEach(({ cat, objCat, realCat, diffCat }) => {
    const pctCat = objCat > 0 ? (diffCat / objCat) * 100 : 0;
    const clsCat = objCat === 0 ? "" : (diffCat > 0.005 ? "neg" : "pos");

    // Cabecera de categoría
    filasHTML += `<tr class="seg-cat-row ${clsCat}">
      <td><strong>${escape(cat)}</strong></td>
      <td class="num">${objCat ? fmtMoney(objCat) : "<span class='muted'>—</span>"}</td>
      <td class="num">${fmtMoney(realCat)}</td>
      <td class="num">${objCat === 0 ? "—" : (diffCat >= 0 ? "+" : "") + fmtMoney(diffCat)}</td>
      <td class="num">${objCat > 0 ? (pctCat >= 0 ? "+" : "") + pctCat.toFixed(0) + "%" : "—"}</td>
    </tr>`;

    // Subcategorías de esa categoría
    const subsObj = objSubMap[cat] || {};
    const subsReal = realPorSub[cat] || {};
    const todasSubs = new Set([...Object.keys(subsObj), ...Object.keys(subsReal)]);
    // Si la categoría está definida en catGastos, mostrar también las subs con objetivo definido en orden natural
    const catDef = state.catGastos.find((c) => c.cat === cat);
    const subsOrden = catDef && catDef.subs ? catDef.subs.filter((s) => todasSubs.has(s)) : [];
    todasSubs.forEach((s) => { if (!subsOrden.includes(s)) subsOrden.push(s); });

    const filasSub = subsOrden.map((sub) => {
      const obj = Number(subsObj[sub]) || 0;
      const real = Number(subsReal[sub]) || 0;
      if (obj === 0 && real === 0) return "";
      const diff = real - obj;
      const pct = obj > 0 ? (diff / obj) * 100 : 0;
      const cls = obj === 0 ? "" : (diff > 0.005 ? "neg" : "pos");
      return `<tr class="seg-sub-row ${cls}">
        <td><span class="seg-sub-name">${escape(sub)}</span></td>
        <td class="num">${obj ? fmtMoney(obj) : "<span class='muted'>—</span>"}</td>
        <td class="num">${fmtMoney(real)}</td>
        <td class="num">${obj === 0 ? "—" : (diff >= 0 ? "+" : "") + fmtMoney(diff)}</td>
        <td class="num">${obj > 0 ? (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%" : "—"}</td>
      </tr>`;
    }).join("");
    filasHTML += filasSub;
  });

  const totalObj = Number(state.objetivos.gastoMes) || 0;
  const totalReal = catsOrdenadas.reduce((a, c) => a + c.realCat, 0);
  const totalDiff = totalReal - totalObj;
  const totalPct = totalObj > 0 ? (totalDiff / totalObj) * 100 : 0;
  const totalCls = totalObj === 0 ? "" : (totalDiff > 0 ? "neg" : "pos");

  det.innerHTML = `
    <h3>Gasto por categoría y subcategoría — ${escape(nombreMesISO(mesISO))}${enCurso}</h3>
    <table class="tabla compact seg-tabla seg-tabla-sub">
      <thead><tr>
        <th>Categoría / Subcategoría</th>
        <th class="num">Objetivo</th>
        <th class="num">Real</th>
        <th class="num">Δ €</th>
        <th class="num">Δ %</th>
      </tr></thead>
      <tbody>
        ${filasHTML || `<tr><td colspan="5" class="muted center">Sin datos. Define objetivos en la pestaña Objetivos.</td></tr>`}
      </tbody>
      <tfoot>
        <tr>
          <th>Total</th>
          <th class="num">${totalObj ? fmtMoney(totalObj) : "—"}</th>
          <th class="num">${fmtMoney(totalReal)}</th>
          <th class="num ${totalCls}">${totalObj === 0 ? "—" : (totalDiff >= 0 ? "+" : "") + fmtMoney(totalDiff)}</th>
          <th class="num">${totalObj > 0 ? (totalPct >= 0 ? "+" : "") + totalPct.toFixed(0) + "%" : "—"}</th>
        </tr>
      </tfoot>
    </table>
  `;
}

function mostrarDetalleObjCategoria(mesISO, modo, cat) {
  // Al clicar una barra individual: destacamos la fila de cabecera de esa categoría
  mostrarTablaObj(mesISO, modo);
  if (cat === "Total") return;
  const det = $("#seg-obj-detalle");
  if (!det) return;
  det.querySelectorAll(".seg-tabla .seg-cat-row").forEach((tr) => {
    if ((tr.firstElementChild?.textContent || "").trim() === cat) {
      tr.classList.add("seg-top");
      tr.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

// Listeners
["seg-vista", "seg-rango", "seg-ingresos"].forEach((id) => {
  document.addEventListener("change", (e) => { if (e.target.id === id) renderChartEvo(); });
});
["seg-obj-modo", "seg-obj-mes"].forEach((id) => {
  document.addEventListener("change", (e) => { if (e.target.id === id) renderChartObj(); });
});

// ============================================================
// RENDER GLOBAL
// ============================================================
function renderAll() {
  if (!sessionUserId) return;
  ensureObjetivos();
  preparaFormGasto();
  preparaFormIngreso();
  preparaFormAhorro();
  preparaFormInversion();
  renderInicio();
  renderGastos();
  renderIngresos();
  renderAhorros();
  renderInversiones();
  renderCuadre();
  renderPropuestas();
  renderObjetivos();
  if (_segActivo) renderSeguimiento();
  // Ajustes
  const fh = $("#form-hogar");
  if (fh) {
    fh.nombre.value = state.hogar.nombre || "";
    fh.moneda.value = state.hogar.moneda || "€";
  }
  if (inpSyncCode) inpSyncCode.value = syncCode;
  if (inpSyncMaster) inpSyncMaster.value = syncMasterKey;
  if (chkSyncAuto) chkSyncAuto.checked = syncAuto;
  renderMiembros();
  renderCategorias();
  renderRepartoDefault();
}

// ============================================================
// INICIO
// ============================================================
setupTabs();

// Si ya teníamos sesión y miembros → entrar directo
// Si la app tiene las 2 casas preconfiguradas, siempre mostramos el login (pide pass casa).
// Si no, intentamos auto-login con la sesión guardada (modo clásico).
if (appConfigOK()) {
  mostrarLogin();
} else {
  const yoStored = sessionUserId ? getMiembro(sessionUserId) : null;
  if (yoStored) entrarComo(yoStored);
  else mostrarLogin();
}

// Arrancar sync si hay código
if (syncCodeOk()) {
  arrancarPollSync();
  autoSyncAlCargar();
} else {
  actualizarSyncStatus("Sin código de sync");
}
