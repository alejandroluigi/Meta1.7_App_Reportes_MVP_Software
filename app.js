// ===== Configuracion (cambia estos valores a tu ciudad) =====
const CONFIG = {
  // Limite rectangular de la ciudad (ejemplo: Ciudad de Mexico). Sustituir por el de tu ciudad.
  ciudad: { latMin: 19.04, latMax: 19.59, lngMin: -99.37, lngMax: -98.94 },
  centroMapa: [19.4326, -99.1332],
  maxBytes: 50 * 1024 * 1024, // limite de 50 MB en IndexedDB
  apiUrl: null                // null = servidor simulado. Ej: 'https://tu-api.com/reportes'
};
const USUARIO_ACTUAL = 'user_demo'; // En el proyecto final vendria del modulo de autenticacion

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const form = $('form-reporte'), descripcion = $('descripcion'), contador = $('contador');
  const errorDesc = $('error-descripcion'), inputCoord = $('coordenadas'), errorCoord = $('error-coordenadas');
  const toggle = $('toggle-anonimo'), msgAnonimo = $('msg-anonimo'), msgExito = $('msg-exito');
  const estadoRed = $('estado-red'), pendientes = $('pendientes'), toast = $('toast');
  const modal = $('modal-mapa');

  // ===== Utilidades de UI =====
  let toastTimer;
  function mostrarToast(texto) {
    toast.textContent = texto;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  function mostrarError(el, texto) { el.textContent = texto; el.hidden = false; }

  // ===== Feature 3: IndexedDB =====
  function abrirDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB no soportado'));
      const req = indexedDB.open('reportes_db', 1); // versión 1: base para futuras migraciones
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('offline_reports'))
          db.createObjectStore('offline_reports', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('failed_reports'))
          db.createObjectStore('failed_reports', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const dbPromise = abrirDB().catch((err) => {
    console.error('Modo offline no disponible:', err);
    mostrarToast('Tu navegador no soporta IndexedDB: el modo offline no estara disponible.');
    return null;
  });

  async function op(store, modo, fn) {
    const db = await dbPromise;
    if (!db) throw new Error('IndexedDB no disponible');
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, modo);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  }
  const guardar = (store, obj) => op(store, 'readwrite', (s) => s.add(obj));
  const listar = (store) => op(store, 'readonly', (s) => s.getAll()); // orden por clave = FIFO
  const borrar = (store, id) => op(store, 'readwrite', (s) => s.delete(id));

  async function actualizarPendientes() {
    try {
      const n = (await listar('offline_reports')).length;
      pendientes.textContent = n ? `Reportes pendientes de sincronizar: ${n}` : '';
    } catch { pendientes.textContent = ''; }
  }

  async function guardarOffline(reporte) {
    try {
      const actuales = await listar('offline_reports');
      const usado = actuales.reduce((n, r) => n + new Blob([JSON.stringify(r)]).size, 0);
      if (usado + new Blob([JSON.stringify(reporte)]).size > CONFIG.maxBytes) {
        mostrarToast('Almacenamiento local lleno (50 MB). Conectate para sincronizar.');
        return false;
      }
      await guardar('offline_reports', reporte);
      mostrarToast('Reporte guardado en el dispositivo. Se enviara al recuperar la conexion.');
      await actualizarPendientes();
      return true;
    } catch (err) {
      console.error(err);
      mostrarToast('No se pudo guardar el reporte sin conexion.');
      return false;
    }
  }

  // ===== Feature 2: localizacion (validacion y geofencing) =====
  function parsearCoordenadas(txt) {
    const m = txt.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }
  function dentroDeCiudad(lat, lng) {
    const c = CONFIG.ciudad;
    return lat >= c.latMin && lat <= c.latMax && lng >= c.lngMin && lng <= c.lngMax;
  }

  // ===== Servidor (real o simulado) =====
  async function enviarAlServidor(reporte) {
    if (CONFIG.apiUrl) {
      const r = await fetch(CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reporte)
      });
      return r.status;
    }
    await new Promise((r) => setTimeout(r, 300)); // simulacion
    return dentroDeCiudad(reporte.lat, reporte.lng) ? 201 : 400;
  }

  // ===== Sincronizacion automatica (FIFO) =====
  let sincronizando = false;
  async function sincronizar() {
    if (sincronizando || !navigator.onLine) return;
    sincronizando = true;
    try {
      const cola = await listar('offline_reports');
      for (const registro of cola) {
        let status;
        try { status = await enviarAlServidor(registro); } catch { break; }
        if (status === 201) {
          await borrar('offline_reports', registro.id);
        } else if (status === 400) {
          const { id, ...resto } = registro;
          await guardar('failed_reports', resto); // no bloquea los demas
          await borrar('offline_reports', id);
        } else break;
      }
      mostrarToast('Sincronizacion completada.');
    } catch (err) {
      console.error('Sincronizacion fallida:', err);
    } finally {
      sincronizando = false;
      actualizarPendientes();
    }
  }

  function actualizarEstadoRed() {
    estadoRed.textContent = navigator.onLine ? 'Conectado' : 'Sin conexion: los reportes se guardaran en el dispositivo';
  }
  window.addEventListener('online', () => { actualizarEstadoRed(); sincronizar(); });
  window.addEventListener('offline', actualizarEstadoRed);

  // ===== Mapa interactivo (Leaflet + OpenStreetMap) =====
  let mapa = null, marcador = null;
  function cerrarMapa() { modal.hidden = true; }
  function abrirMapa() {
    if (typeof L === 'undefined') {
      mostrarToast('No se pudo cargar el mapa (sin internet?). Escribe las coordenadas a mano.');
      return;
    }
    modal.hidden = false;
    if (!mapa) {
      mapa = L.map('mapa').setView(CONFIG.centroMapa, 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap'
      }).addTo(mapa);
      mapa.on('click', (e) => {
        inputCoord.value = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
        if (marcador) marcador.setLatLng(e.latlng); else marcador = L.marker(e.latlng).addTo(mapa);
        errorCoord.hidden = true;
        cerrarMapa();
      });
    }
    setTimeout(() => mapa.invalidateSize(), 0);
  }
  $('btn-mapa').addEventListener('click', abrirMapa);
  $('btn-cerrar-mapa').addEventListener('click', cerrarMapa);

  // ===== Feature 1: anonimato =====
  toggle.addEventListener('change', () => { msgAnonimo.hidden = !toggle.checked; });

  // ===== Formulario =====
  descripcion.addEventListener('input', () => {
    contador.textContent = `${descripcion.value.length} / 500`;
    if (descripcion.value.trim()) errorDesc.hidden = true;
    msgExito.hidden = true;
  });
  inputCoord.addEventListener('input', () => { errorCoord.hidden = true; });

  function limpiarFormulario() {
    form.reset();
    contador.textContent = '0 / 500';
    msgAnonimo.hidden = true;
    if (marcador && mapa) { mapa.removeLayer(marcador); marcador = null; }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = descripcion.value.trim();
    const coords = parsearCoordenadas(inputCoord.value);
    let valido = true;

    if (!texto) { mostrarError(errorDesc, 'Por favor describe el incidente antes de enviar.'); valido = false; }
    if (!coords) {
      mostrarError(errorCoord, 'Ingresa coordenadas validas en grados decimales, por ejemplo 19.432608, -99.133209.');
      valido = false;
    } else if (!dentroDeCiudad(coords.lat, coords.lng)) {
      mostrarError(errorCoord, 'La ubicacion esta fuera de la zona permitida de la ciudad.');
      valido = false;
    }
    if (!valido) return;

    const anonimo = toggle.checked;
    const reporte = {
      descripcion: texto,
      lat: coords.lat,
      lng: coords.lng,
      isAnonymous: anonimo,
      userId: anonimo ? 'system_anonymous' : USUARIO_ACTUAL, // ofuscacion del ID
      creadoEn: new Date().toISOString()
    };

    let guardadoOk = false;
    if (!navigator.onLine) {
      guardadoOk = await guardarOffline(reporte);
    } else {
      try {
        const status = await enviarAlServidor(reporte);
        if (status === 201) {
          msgExito.textContent = anonimo ? 'Reporte enviado de forma anonima.' : 'Reporte enviado.';
          msgExito.hidden = false;
          guardadoOk = true;
        } else if (status === 400) {
          mostrarError(errorCoord, 'El servidor rechazo el reporte: coordenadas invalidas o fuera de la ciudad.');
        } else {
          guardadoOk = await guardarOffline(reporte);
        }
      } catch {
        guardadoOk = await guardarOffline(reporte); // fallo la red
      }
    }
    console.log('Reporte:', reporte);
    if (guardadoOk) limpiarFormulario();
  });

  actualizarEstadoRed();
  actualizarPendientes();
  sincronizar();
});
