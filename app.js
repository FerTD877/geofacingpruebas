// ==========================================
// CONFIGURACIÓN GLOBAL Y PARÁMETROS
// ==========================================
const MODO_PRUEBA = false;
const PROBAR_DIA = "MA";
const PROBAR_BLOQUE = "0940";

// --- CONFIGURACIÓN DE VISTA INICIAL Y LÍMITES ---
// Coordenadas del mapa: píxeles del lienzo del SVG (2000 x 1818), con (0,0) = esquina superior izquierda.
// Tip: con el mapa abierto, ejecuta  vistaActual()  en la consola del navegador para
// leer el centro y el zoom que estás viendo y copiarlos aquí.
const VISTA_INICIAL_CONFIG = {
    zoom: 2,         // 1 = mapa completo (zoom mínimo); 3 = triple; etc.
    enfocarId: null, // id de un elemento del SVG (ej. 'AD4') para iniciar centrado en él; tiene prioridad sobre 'centro'
    centro: { x: 1091, y: 626 }  // zona del BOULEVARD. null = centro del mapa
};

// Cómo se mueve el mapa en pantalla:
//  'viewbox'   : el SVG tiene el tamaño de la pantalla y se mueve cambiando su viewBox. El navegador lo dibuja siempre a la
//                escala exacta, sin capas gigantes estiradas (evita parpadeos en algunos móviles).
//  'transform' : el SVG completo se mueve con una transformación CSS (puede ser más fluido en equipos potentes, pero en
//                algunos móviles las capas se redibujan por partes y parpadean al acercar/alejar).
const RENDER_CONFIG = { modo: 'viewbox' };
let vistaBase = { x: 0, y: 0, kx: 1, ky: 1 }; // viewBox del mapa completo y unidades del SVG por píxel

// Zoom y pan automáticos al buscar o resaltar
const ENCUADRE_CONFIG = {
    margen: 70,        // px libres alrededor de lo que se encuadra
    zoomBusqueda: 2,   // zoom "cómodo" (relativo al mapa completo = 1) cuando hay muchos elementos dispersos
    zoomMaximo: 3,     // acercamiento máximo al encuadrar (relativo al mapa completo)
    duracion: 900,            // ms que dura el movimiento al buscar o resaltar (0 = salto directo). Súbelo para un movimiento más lento
    duracionBotones: 220,     // ms de los botones + y −
    // true  = si el sistema pide "reducir animaciones" (Windows: "Efectos de animación" desactivados;
    //         Android/Samsung: "Quitar animaciones"), el mapa salta directo, sin animar.
    // false = anima siempre, aunque el sistema pida reducirlas.
    respetarMovimientoReducido: false
};

const LIMITES_CONFIG = {
    modoMinimo: 'cubrir', // 'cubrir': nunca hay bordes vacíos (puede recortar un eje)
                          // 'contener': se ve el mapa completo, con márgenes en un eje
    zoomMaximo: 8,        // escala máxima (píxeles de pantalla por unidad del SVG)
    velocidadRueda: 0.004,// sensibilidad del zoom con la rueda / trackpad
    // Los límites son exactamente el viewBox del SVG (el marco negro coincide con él).
    // Recorte opcional extra, en px del lienzo, por si algún día quieres acotar más el mapa.
    recorte: { izq: 0, der: 0, arriba: 0, abajo: 0 }
};

let baseDeDatosHorarios = [];
let listaSugerencias = [];
let salonesRegistradosEnMapa = new Set();
let salonesExcluidosSet = new Set();    
const escuelaPorIdEdificio = new Map();

// Estructuras que no son salones (escuelas, departamentos, cantinas...), definidas en estructuras.json
let estructurasConfig = { tipos: {}, estructuras: [] };
const estructuraPorId = new Map();     // id del elemento SVG -> estructura
const estructuraPorSalon = new Map();  // salón sin elemento propio (dentro de una escuela...) -> estructura

// Dimensiones y transformación del mapa
let anchoRealSVG = 0;
let altoRealSVG = 0;
let anchoContenedor = 0;
let altoContenedor = 0;
let mapaInicializado = false;
let escala = 1;
let escalaMinimaPermitida = 1;
let escalaMaximaPermitida = 8;
let transX = 0;
let transY = 0;
let contenedorMapa = null;
let svgEl = null;
let renderPendiente = false;

// Gestos (Pointer Events: ratón, táctil y lápiz con el mismo código)
const punteros = new Map();   // pointerId -> {x, y}
let inicioToque = { x: 0, y: 0 };
let huboArrastre = false;
let huboMultitouch = false;
let ultimoPellizco = null;

let salonActivoActual = null;

// Caches para no recorrer el DOM en cada acción
const elementosSalon = new Map();      // id -> elemento SVG
const elementosResaltados = new Set(); // elementos con clase de resaltado activa

// --- 0. CARGA DINÁMICA DEL MAPA SVG (FETCH) ---
// Descarga con tiempo límite y un reintento. Lanza ErrorCarga con un mensaje que se puede mostrar al usuario.
let TIEMPO_LIMITE_MS = 20000;

class ErrorCarga extends Error {
    constructor(tipo, mensaje) { super(mensaje); this.tipo = tipo; }
}

async function pedir(url, { texto = false } = {}) {
    let ultimo;
    for (let intento = 0; intento < 2; intento++) {
        const control = new AbortController();
        const reloj = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);
        try {
            const respuesta = await fetch(url, { signal: control.signal });
            if (!respuesta.ok) throw new ErrorCarga('http', `El servidor respondió con el error ${respuesta.status}.`);
            if (respuesta.headers.get('x-desde-cache') === '1') anotarDatoDeCache(respuesta.headers.get('x-guardado'));
            return texto ? await respuesta.text() : await respuesta.json();
        } catch (e) {
            if (e instanceof ErrorCarga) ultimo = e;
            else if (e.name === 'AbortError') ultimo = new ErrorCarga('lento', 'La conexión es muy lenta y la descarga no terminó a tiempo.');
            else if (e instanceof SyntaxError) ultimo = new ErrorCarga('formato', 'El archivo no tiene un formato válido.');
            else if (navigator.onLine === false) ultimo = new ErrorCarga('sin-conexion', 'Parece que no tienes conexión a internet.');
            else ultimo = new ErrorCarga('red', 'No se pudo conectar con el servidor.');
        } finally {
            clearTimeout(reloj);
        }
        // un 4xx o un archivo mal formado no se arregla reintentando
        if (ultimo.tipo === 'formato' || (ultimo.tipo === 'http' && /error 4/.test(ultimo.message))) break;
        if (intento === 0) await new Promise(r => setTimeout(r, 1200));
    }
    throw ultimo;
}

// Si el modo sin conexión sirvió algún dato desde la copia guardada, aquí queda la fecha (ms) de la más antigua
let datosDesdeCache = null;
function anotarDatoDeCache(guardadoMs) {
    const t = Number(guardadoMs) || Date.now();
    datosDesdeCache = datosDesdeCache ? Math.min(datosDesdeCache, t) : t;
}

// Cada carga devuelve null si todo fue bien, o el ErrorCarga si falló
let mapaCargado = false;
let horariosListos = false;
let estructurasListas = false;

async function cargarSVGMapa() {
    const contenedor = document.querySelector('.mapa-placeholder');
    try {
        const texto = await pedir('./mapageofacing.svg', { texto: true });
        if (!/<svg[\s>]/i.test(texto)) throw new ErrorCarga('formato', 'El archivo del mapa no es un SVG válido.');

        contenedor.innerHTML = texto;
        const svgElemento = contenedor.querySelector('svg');
        if (svgElemento) svgElemento.id = 'svg1';

        registrarSalonesDinamicos();
        mapaCargado = true;
        console.log(`✅ SVG cargado. Registrados ${salonesRegistradosEnMapa.size} espacios interactivos.`);
        return null;
    } catch (error) {
        console.error("❌ Error al cargar mapageofacing.svg:", error);
        return error;
    }
}

function registrarSalonesDinamicos() {
    salonesRegistradosEnMapa.clear();
    elementosSalon.clear();
    elementosResaltados.clear();
    document.querySelectorAll('#svg1 [id]').forEach(el => {
        const id = el.id.trim();
        if (/[A-Z]/.test(id) && id === id.toUpperCase() && id !== 'SVG1') {
            salonesRegistradosEnMapa.add(id);
            elementosSalon.set(id, el);
            el.classList.add('salon'); // la transición CSS solo se aplica a estos nodos
            el.style.cursor = 'pointer';
        }
    });
}

// --- 1. CARGA Y PROCESAMIENTO DE DATOS ---
async function cargarHorarios() {
    try {
        const datos = await pedir('./horarios.json');
        if (!Array.isArray(datos)) throw new ErrorCarga('formato', 'El archivo de horarios no tiene un formato válido.');
        baseDeDatosHorarios = datos;
        horariosListos = true;
        return null;
    } catch (error) {
        console.error("❌ Error al cargar horarios.json:", error);
        return error;
    }
}

// Las entradas «Escuela X - Edificio N» existen solo para asignar salones a un edificio concreto;
// no se ofrecen en el buscador (se busca la escuela y se resaltan todos sus edificios).
const esEdificioDeEscuela = (est) => est.oculto === true || /[-–—]\s*EDIFICIO\s*\d*\s*$/.test(plegar(est.nombre));

function procesarSugerencias() {
    const mapa = new Map();
    estructurasConfig.estructuras.forEach(est => {
        if (esEdificioDeEscuela(est)) return;
        const tipo = estructurasConfig.tipos[est.tipo] || {};
        mapa.set(`EST_${est.nombre}`, { texto: est.nombre, tipo: 'Estructura', subtitulo: tipo.etiqueta || 'Lugar', icono: tipo.icono || '📍', valorBusqueda: est.nombre, tipoClave: est.tipo });
    });
    baseDeDatosHorarios.forEach(bloque => {
        const [codigo, materia, seccion, profesor, dia, hora, salon] = bloque;
        
        if (profesor && !mapa.has(`PROF_${profesor}`)) mapa.set(`PROF_${profesor}`, { texto: profesor, tipo: 'Profesor', icono: '👨‍🏫', valorBusqueda: profesor });
        if (salon && !mapa.has(`SALON_${salon}`)) mapa.set(`SALON_${salon}`, { texto: salon, tipo: 'Salón', icono: '📍', valorBusqueda: salon });
        
        const claveMateria = materia || codigo;
        if (claveMateria && !mapa.has(`MAT_${codigo}_${materia}`)) {
            const etiquetaUnificada = codigo && materia ? `${codigo} - ${materia}` : claveMateria;
            mapa.set(`MAT_${codigo}_${materia}`, { texto: etiquetaUnificada, tipo: 'Materia', icono: '📚', valorBusqueda: etiquetaUnificada, codigo, nombre: materia || '' });
        }
    });
    listaSugerencias = Array.from(mapa.values());
}

// --- 2. GENERACIÓN DE TABLA Y LEYENDA ---
const DIAS_CLAVE = ["LU", "MA", "MI", "JU", "VI", "SA"];
const NOMBRES_DIAS = ["LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];
const BLOQUES_HORAS = ["0800", "0850", "0940", "1030", "1120", "1210", "1300", "1350", "1440", "1530", "1620", "1710", "1800", "1850", "1940"];

function generarTablaHorario(bloquesFiltrados) {
    const contenedorLeyenda = document.getElementById('leyenda-panel');
    if (!bloquesFiltrados || bloquesFiltrados.length === 0) {
        if (contenedorLeyenda) contenedorLeyenda.innerHTML = '';
        return `<div style="padding: 20px; text-align: center; color: #5f6368;">No se encontraron clases.</div>`;
    }

    const mapaHorario = {};
    const mapaLeyenda = new Map();

    BLOQUES_HORAS.forEach(hora => {
        mapaHorario[hora] = {};
        DIAS_CLAVE.forEach(dia => mapaHorario[hora][dia] = []);
    });

    bloquesFiltrados.forEach(bloque => {
        const [codigo, materia, seccion, profesor, dia, hora, salon] = bloque;
        const claveUnicaSec = `${codigo}_${seccion}`;
        if (codigo && !mapaLeyenda.has(claveUnicaSec)) {
            mapaLeyenda.set(claveUnicaSec, { codigo, seccion, nombre: materia || 'Sin nombre', profesor: profesor ? `Prof. ${profesor}` : 'Prof. Por asignar' });
        }
        if (mapaHorario[hora] && mapaHorario[hora][dia]) mapaHorario[hora][dia].push({ codigo, seccion, salon });
    });

    let html = `<table class="tabla-horario"><thead><tr><th>HORA</th>${NOMBRES_DIAS.map(d => `<th>${d.substring(0, 3)}</th>`).join('')}</tr></thead><tbody>`;
    BLOQUES_HORAS.forEach(hora => {
        html += `<tr><td class="col-hora">${hora}</td>`;
        DIAS_CLAVE.forEach(dia => {
            const clases = mapaHorario[hora][dia];
            html += clases.length > 0 ? `<td class="celda-activa">${clases.map(c => `
                <div class="bloque-celda">
                    <span class="materia-sec">${c.codigo}-${c.seccion}</span>
                    <span class="salon-tag" onclick="enfocarSalonDesdeTabla('${c.salon}')">${c.salon}</span>
                </div>
            `).join('<hr class="separador-bloque">')}</td>` : `<td></td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    generarLeyendaHTML(mapaLeyenda);
    return html;
}

function generarLeyendaHTML(mapaLeyenda) {
    const contenedorLeyenda = document.getElementById('leyenda-panel');
    if (!contenedorLeyenda) return;
    let htmlLeyenda = `<ul>`;
    mapaLeyenda.forEach((info) => htmlLeyenda += `<li><strong>${info.codigo}</strong>: ${info.nombre} - Sección: ${info.seccion} - ${info.profesor}</li>`);
    htmlLeyenda += `</ul>`;
    contenedorLeyenda.innerHTML = htmlLeyenda;
}

// --- 3. GESTIÓN DE PANELES Y BÚSQUEDA ---
// --- GESTIÓN DE PANELES CON EL BOTÓN "ATRÁS" DEL MÓVIL ---

function abrirPanelResultados(htmlContenido) {
    document.getElementById('contenido-panel').innerHTML = htmlContenido;
    document.getElementById('panel-info').classList.remove('activo');
    const panel = document.getElementById('modulo-resultados');
    panel.classList.add('activo');
    panel.classList.remove('minimizado'); // una búsqueda nueva siempre muestra el panel
    panel.classList.remove('expandido', 'hoja-baja');  // en el teléfono arranca asomando (primero se ve el mapa)
    panel.querySelector('.panel-scroll').scrollTop = 0;
    restablecerBotonMinimizar();
    actualizarEstadoHoja();
    abrirCapaHistorial();
}

// --- HOJA INFERIOR DEL TELÉFONO (horarios) ---
// En pantallas estrechas el panel de horarios es una hoja que sube desde abajo:
// 'asomada' (solo la parte alta, el mapa se ve primero) o 'expandida' (casi toda la pantalla).
// ¡Mantén alturaAsomada igual que 38dvh en styles.css y el ancho igual al @media de styles.css!
const HOJA_MOVIL = { alturaAsomada: 0.38, alturaBajaPx: 64, mediaQuery: '(max-width: 768px)' }; // alturaBajaPx = 64px del CSS (.hoja-baja)
const mqMovil = window.matchMedia(HOJA_MOVIL.mediaQuery);
const esVistaMovil = () => mqMovil.matches;

function actualizarEstadoHoja() {
    const panel = document.getElementById('modulo-resultados');
    const activo = panel.classList.contains('activo');
    const estado = estadoHoja();
    document.body.classList.toggle('hoja-asomada', activo && estado === 'asomada');
    document.body.classList.toggle('hoja-expandida', activo && estado === 'expandida');
    document.body.classList.toggle('hoja-baja', activo && estado === 'baja');
    const asa = document.getElementById('asa-hoja');
    if (asa) asa.setAttribute('aria-label', estado === 'asomada' ? 'Subir el horario' : (estado === 'baja' ? 'Mostrar el horario' : 'Bajar el horario'));
    reajustarVistaPorHoja(); // el margen inferior permitido al mapa depende del estado de la hoja
}

// Estados de la hoja: 'baja' (solo asa y X, el mapa casi completo), 'asomada' (38 %) y 'expandida'
function estadoHoja() {
    const panel = document.getElementById('modulo-resultados');
    if (panel.classList.contains('expandido')) return 'expandida';
    if (panel.classList.contains('hoja-baja')) return 'baja';
    return 'asomada';
}

function establecerHoja(estado) {
    const panel = document.getElementById('modulo-resultados');
    panel.classList.toggle('expandido', estado === 'expandida');
    panel.classList.toggle('hoja-baja', estado === 'baja');
    actualizarEstadoHoja();
}

function alternarHoja(expandir) {
    if (typeof expandir === 'boolean') { establecerHoja(expandir ? 'expandida' : 'asomada'); return; }
    establecerHoja(estadoHoja() === 'asomada' ? 'expandida' : 'asomada'); // desde 'baja' vuelve a asomar
}

// Espacio extra (px) que el mapa puede desplazarse por debajo de su borde para que lo que está en el sur
// quede por encima de la hoja. Sin esto, los bordes herméticos impedían subir esa zona sobre la hoja.
let panelHojaEl = null;
function margenInferiorHoja() {
    if (!esVistaMovil()) return 0;
    if (!panelHojaEl) panelHojaEl = document.getElementById('modulo-resultados');
    if (!panelHojaEl || !panelHojaEl.classList.contains('activo')) return 0;
    return panelHojaEl.classList.contains('hoja-baja')
        ? HOJA_MOVIL.alturaBajaPx + 10
        : altoContenedor * HOJA_MOVIL.alturaAsomada + 10;
}

// Al cambiar la hoja, si la vista queda fuera de los nuevos límites se corrige con una transición suave
function reajustarVistaPorHoja() {
    if (!mapaInicializado) return;
    const x0 = transX, y0 = transY;
    limitarTraslacion();
    const x1 = transX, y1 = transY;
    transX = x0; transY = y0;
    if (Math.abs(x1 - x0) < 0.5 && Math.abs(y1 - y0) < 0.5) return;
    cancelarAnimacionVista();
    const t0 = performance.now(), DUR = 300;
    const paso = (ahora) => {
        const t = Math.min(1, (ahora - t0) / DUR);
        const k = 1 - Math.pow(1 - t, 3);
        transX = x0 + (x1 - x0) * k;
        transY = y0 + (y1 - y0) * k;
        renderizarAhora();
        animacionVista = t < 1 ? requestAnimationFrame(paso) : null;
    };
    animacionVista = requestAnimationFrame(paso);
}

function inicializarHojaMovil() {
    const panel = document.getElementById('modulo-resultados');
    const UMBRAL = 10, DISTANCIA = 40; // px para empezar a arrastrar / para decidir subir o bajar
    let y0 = null, arrastrando = false, acaboDeArrastrar = false;

    panel.addEventListener('pointerdown', (e) => {
        if (!esVistaMovil() || !panel.classList.contains('activo')) return;
        if (e.target.closest('button:not(#asa-hoja)')) return;
        // asomada: se puede arrastrar desde cualquier punto; expandida: solo desde el asa (el resto hace scroll)
        if (panel.classList.contains('expandido') && !e.target.closest('#asa-hoja')) return;
        y0 = e.clientY; arrastrando = false;
    });
    panel.addEventListener('pointermove', (e) => {
        if (y0 === null) return;
        if (!arrastrando && Math.abs(e.clientY - y0) > UMBRAL) {
            arrastrando = true;
            try { panel.setPointerCapture(e.pointerId); } catch (_) {}
        }
    });
    const terminar = (e) => {
        if (y0 === null) return;
        const dy = e.clientY - y0;
        if (arrastrando && e.type === 'pointerup') {
            if (dy < -DISTANCIA) establecerHoja(estadoHoja() === 'baja' ? 'asomada' : 'expandida');
            else if (dy > DISTANCIA) establecerHoja(estadoHoja() === 'expandida' ? 'asomada' : 'baja');
            acaboDeArrastrar = true;
            setTimeout(() => { acaboDeArrastrar = false; }, 0);
        }
        y0 = null; arrastrando = false;
    };
    panel.addEventListener('pointerup', terminar);
    panel.addEventListener('pointercancel', terminar);
    // un arrastre no debe contar como toque sobre una fila o etiqueta de salón
    panel.addEventListener('click', (e) => { if (acaboDeArrastrar) { e.stopPropagation(); e.preventDefault(); } }, true);

    const asa = document.getElementById('asa-hoja');
    if (asa) asa.addEventListener('click', () => { if (esVistaMovil() && !acaboDeArrastrar) alternarHoja(); });
    if (mqMovil.addEventListener) mqMovil.addEventListener('change', actualizarEstadoHoja);
    else mqMovil.addListener(actualizarEstadoHoja);
}

function restablecerBotonMinimizar() {
    const btn = document.getElementById('btn-minimizar-panel');
    if (btn) {
        btn.textContent = '‹';
        btn.setAttribute('aria-label', 'Ocultar panel');
    }
}

// Función para ocultar/mostrar el panel lateralmente (Estilo Google Maps)
function alternarMinimizarPanel() {
    const panel = document.getElementById('modulo-resultados');
    panel.classList.toggle('minimizado');
    
    // Cambia la flecha de dirección según el estado
    const btn = document.getElementById('btn-minimizar-panel');
    if (panel.classList.contains('minimizado')) {
        btn.textContent = '›'; // Apunta hacia afuera para abrir
        btn.setAttribute('aria-label', 'Mostrar panel');
    } else {
        btn.textContent = '‹'; // Apunta hacia adentro para cerrar
        btn.setAttribute('aria-label', 'Ocultar panel');
    }
}

// Oculta los paneles (horario e info de estructura) sin tocar el resaltado del mapa
function ocultarPaneles() {
    const panel = document.getElementById('modulo-resultados');
    panel.classList.remove('activo', 'minimizado'); // si estaba minimizado, que no quede la pestaña suelta
    panel.classList.remove('expandido', 'hoja-baja');
    restablecerBotonMinimizar();
    actualizarEstadoHoja();
    document.getElementById('panel-info').classList.remove('activo');
    document.getElementById('input-busqueda').value = '';
    salonActivoActual = null;
    sincronizarHistorial();
}

function cerrarPanelResultados() {
    ocultarPaneles();
    limpiarResaltadoMapa();
}

function normalizarTextoBusqueda(texto) {
    if (!texto) return '';
    const eq = {'10':'X', '1':'I', '2':'II', '3':'III', '4':'IV', '5':'V', '6':'VI', '7':'VII', '8':'VIII', '9':'IX'};
    return texto.toUpperCase().replace(/\b(10|[1-9])\b/g, (m) => eq[m] || m);
}

// Quita el foco del buscador: en el teléfono esto cierra el teclado virtual
function cerrarTeclado() {
    const input = document.getElementById('input-busqueda');
    if (input && document.activeElement === input) input.blur();
}

function ejecutarBusqueda(texto, opciones = {}) {
    cerrarTeclado(); // la búsqueda terminó (Enter, lupa o sugerencia): fuera teclado
    const rawInput = (texto || document.getElementById('input-busqueda').value).trim();
    const busqueda = normalizarTextoBusqueda(rawInput);
    
    if (!busqueda) { 
        ocultarSugerencias();
        cerrarPanelResultados(); 
        limpiarResaltadoMapa(); 
        return; 
    }

    // Estructura (escuela, departamento, cantina...): ventana pequeña con el nombre, sin horario
    const estructurasExactas = estructurasConfig.estructuras.filter(e => !esEdificioDeEscuela(e) && plegar(e.nombre) === plegar(rawInput));
    if (estructurasExactas.length) { // varias con el mismo nombre ("Cantina"): se resaltan todas
        mostrarInfoEstructura(estructurasExactas, opciones);
        return;
    }

    if (!horariosListos) { // sin horarios solo se pueden buscar lugares
        const parciales = estructurasConfig.estructuras.filter(e => !esEdificioDeEscuela(e) && plegar(e.nombre).includes(plegar(rawInput)));
        const nombres = new Set(parciales.map(e => plegar(e.nombre)));
        if (nombres.size === 1) { mostrarInfoEstructura(parciales, opciones); return; }
        if (nombres.size > 1) { mostrarSugerencias(rawInput); return; }
        avisarHorariosNoDisponibles();
        return;
    }

    const q = plegar(busqueda); // sin tildes (y con números romanos): "geometria" encuentra "GEOMETRÍA"
    const itemCoincidente = listaSugerencias.find(item => plegar(item.texto) === q || plegar(item.valorBusqueda) === q);
    let resultados = [];
    let salonesAEnfocar = new Set();
    // Un id del mapa (tocado o escrito completo) es un lugar: no debe confundirse con una materia
    // que lo contenga en el nombre (ej. «EDIFICIO» vs «INSTALACIONES PARA EDIFICIOS»)
    const soloSalon = !!opciones.soloSalon ||
        (!itemCoincidente && salonesRegistradosEnMapa.has(rawInput.toUpperCase()));

    if (soloSalon) {
        resultados = baseDeDatosHorarios.filter(b => b[6] && plegar(b[6]) === q);
    } else if (itemCoincidente && itemCoincidente.tipo === 'Materia') {
        resultados = baseDeDatosHorarios.filter(b => b[0] === itemCoincidente.codigo);
    } else {
        const materiasCoincidentes = itemCoincidente ? [] : listaSugerencias.filter(item => item.tipo === 'Materia' && plegar(item.texto).includes(q));
        if (materiasCoincidentes.length > 1) {
            mostrarSugerencias(rawInput);
            return;
        }
        resultados = baseDeDatosHorarios.filter(b => {
            const [codigo, materia, seccion, profesor, dia, hora, salon] = b;
            const textoUnificadoMateria = codigo && materia ? `${codigo} - ${materia}` : (materia || codigo || '');
            return (salon && plegar(salon) === q) ||
                   (codigo && plegar(codigo) === q) ||
                   (profesor && plegar(profesor).includes(q)) ||
                   (materia && plegar(materia).includes(q)) ||
                   (plegar(textoUnificadoMateria) === q);
        });
    }

    // Sin horarios: ¿coincide parcialmente con alguna estructura?
    if (resultados.length === 0 && !soloSalon) {
        const parciales = estructurasConfig.estructuras.filter(e => !esEdificioDeEscuela(e) && plegar(e.nombre).includes(plegar(rawInput)));
        const nombresDistintos = new Set(parciales.map(e => plegar(e.nombre)));
        if (nombresDistintos.size === 1) { mostrarInfoEstructura(parciales, opciones); return; }
        if (nombresDistintos.size > 1) { mostrarSugerencias(rawInput); return; }
    }

    ocultarSugerencias();
    resultados.forEach(b => { if (b[6]) salonesAEnfocar.add(b[6].trim().toUpperCase()); });

    // Si se busca un salón concreto (también tocándolo en el mapa), muestra si está libre u ocupado y hasta cuándo
    const idSalonBuscado = (itemCoincidente && itemCoincidente.tipo === 'Salón') ? itemCoincidente.texto.trim().toUpperCase() : rawInput.toUpperCase();
    const esSalon = (itemCoincidente && itemCoincidente.tipo === 'Salón') || salonesRegistradosEnMapa.has(idSalonBuscado);
    const banner = esSalon && !salonesExcluidosSet.has(idSalonBuscado) ? generarBannerEstado(idSalonBuscado) : '';
    abrirPanelResultados(banner + generarTablaHorario(resultados));
    // Solo se señala en el mapa si se buscó un salón concreto. Materias y profesores solo muestran su horario
    // (desde la tabla se puede tocar cada salón para verlo en el mapa).
    if (esSalon || soloSalon) {
        resaltarSalonesEnMapa(salonesAEnfocar.size ? Array.from(salonesAEnfocar) : [idSalonBuscado]);
        if (opciones.encuadrar !== false) encuadrarElementos(elementosResaltados);
    } else {
        limpiarResaltadoMapa();
    }
}

// --- Contorno resaltado en una capa superior (evita que los salones vecinos tapen el borde) ---
const SVG_NS = 'http://www.w3.org/2000/svg';
let capaResaltado = null;

function agregarContornoSuperior(el, clase) {
    const svg = document.getElementById('svg1');
    if (!svg || !el.parentNode || !el.parentNode.getCTM) return;
    if (!capaResaltado || !capaResaltado.isConnected) {
        capaResaltado = document.createElementNS(SVG_NS, 'g');
        capaResaltado.setAttribute('pointer-events', 'none'); // los toques pasan al salón original
        svg.appendChild(capaResaltado);
    }
    const ctmPadre = el.parentNode.getCTM();
    const ctmCapa = capaResaltado.getCTM();
    if (!ctmPadre || !ctmCapa) return;

    // Misma posición que el original, aunque sus grupos tengan transformaciones (scale, matrix...)
    const m = ctmCapa.inverse().multiply(ctmPadre);
    const grupo = document.createElementNS(SVG_NS, 'g');
    grupo.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);

    // Dos copias de la forma: un halo ancho y translúcido debajo, y el contorno nítido encima
    [clase.replace('contorno', 'halo'), clase].forEach(claseCapa => {
        const forma = el.cloneNode(false); // solo la forma, sin hijos
        forma.removeAttribute('id');
        forma.removeAttribute('style');
        forma.setAttribute('class', claseCapa);
        grupo.appendChild(forma);
    });
    capaResaltado.appendChild(grupo);
}

function marcarSalon(idSalon, clase) {
    const el = elementosSalon.get(idSalon) || document.getElementById(idSalon);
    if (!el) return;
    el.classList.add(clase);
    elementosResaltados.add(el);
    agregarContornoSuperior(el, clase === 'salon-libre' ? 'contorno-libre' : 'contorno-resaltado');
}

function resaltarSalonesEnMapa(listaSalones) {
    limpiarResaltadoMapa();
    listaSalones.forEach(idSalon => {
        if (elementosSalon.has(idSalon)) { marcarSalon(idSalon, 'salon-resaltado'); return; }
        const est = estructuraPorSalon.get(idSalon); // salón dentro de una escuela/departamento sin elemento propio
        if (est) est.ids.forEach(id => marcarSalon(id, 'salon-resaltado'));
        else marcarSalon(idSalon, 'salon-resaltado');
    });
}

function enfocarSalonDesdeTabla(idSalon) {
    if (!idSalon) return;
    if (esVistaMovil() && estadoHoja() === 'expandida') establecerHoja('asomada'); // en el teléfono baja la hoja para ver el salón en el mapa
    resaltarSalonesEnMapa([idSalon.toUpperCase()]);
    encuadrarElementos(elementosResaltados);
}

function limpiarResaltadoMapa() {
    elementosResaltados.forEach(el => el.classList.remove('salon-resaltado', 'salon-libre'));
    elementosResaltados.clear();
    if (capaResaltado) capaResaltado.textContent = '';
}

// --- 4. INTERACCIÓN DIRECTA MAPA Y BUSCADOR ---
function inicializarBuscador() {
    document.getElementById('btn-buscar').addEventListener('click', () => ejecutarBusqueda());
    document.getElementById('input-busqueda').addEventListener('input', (e) => mostrarSugerencias(e.target.value));
    document.getElementById('input-busqueda').addEventListener('keydown', (e) => { if (e.key === 'Enter') ejecutarBusqueda(); });
    document.getElementById('btn-cerrar-panel').addEventListener('click', cerrarPanelResultados);
    document.getElementById('btn-cerrar-info').addEventListener('click', cerrarPanelResultados);
    
}

// Orden de las sugerencias: 1) código de materia, 2) nombre de materia, 3) salón, 4) profesor, 5) estructuras
const ORDEN_ESTRUCTURAS = ['escuela', 'decanato', 'direccion', 'departamento']; // el resto de lugares va después

function escaparHTML(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Devuelve [grupo, 0|1] si el item coincide (0 = empieza por lo escrito, 1 = solo lo contiene) o null si no coincide
function puntuarSugerencia(item, q, qRomano) {
    const pos = (texto, consulta) => { const i = plegar(texto).indexOf(consulta); return i < 0 ? null : (i === 0 ? 0 : 1); };
    switch (item.tipo) {
        case 'Materia': {
            const porCodigo = item.codigo ? pos(item.codigo, qRomano) : null;
            if (porCodigo !== null) return [0, porCodigo];
            const porNombre = pos(item.nombre || item.texto, qRomano);
            if (porNombre !== null) return [1, porNombre];
            const porTexto = pos(item.texto, qRomano); // lo escrito abarca código y nombre («ma1c01 - cal»)
            return porTexto === null ? null : [1, 1];
        }
        case 'Salón': { const p = pos(item.texto, qRomano); return p === null ? null : [2, p]; }
        case 'Profesor': { const p = pos(item.texto, qRomano); return p === null ? null : [3, p]; }
        case 'Estructura': {
            const p = pos(item.texto, q);
            if (p === null) return null;
            const i = ORDEN_ESTRUCTURAS.indexOf(item.tipoClave);
            return [4 + (i < 0 ? ORDEN_ESTRUCTURAS.length : i), p];
        }
    }
    return null;
}

function mostrarSugerencias(filtro) {
    const box = document.getElementById('sugerencias-box');
    const busqueda = normalizarTextoBusqueda(filtro.trim());
    if (!busqueda) { box.classList.add('oculto'); return; }

    const q = plegar(filtro.trim());   // sin acentos, para estructuras ("cantina 1", "direccion")
    const qRomano = plegar(busqueda);  // con números romanos, para materias
    const coinc = [];
    listaSugerencias.forEach(item => {
        const p = puntuarSugerencia(item, q, qRomano);
        if (p) coinc.push({ item, grupo: p[0], pos: p[1] });
    });
    if (coinc.length === 0) { box.classList.add('oculto'); return; }
    // por categoría; dentro de ella, primero lo que empieza por lo escrito y luego alfabético
    coinc.sort((a, b) => (a.grupo - b.grupo) || (a.pos - b.pos) || a.item.texto.localeCompare(b.item.texto, 'es'));

    box.innerHTML = coinc.map(({ item: i }) => `<div class="sugerencia-item" data-valor="${escaparHTML(i.valorBusqueda)}"><span class="sugerencia-icono">${i.icono}</span><div class="sugerencia-texto"><span class="sugerencia-titulo">${escaparHTML(i.texto)}</span><span class="sugerencia-subtitulo">${escaparHTML(i.subtitulo || i.tipo)}</span></div></div>`).join('');
    box.scrollTop = 0;
    box.classList.remove('oculto');

    box.onclick = (e) => { // un solo manejador para toda la lista
        const el = e.target.closest('.sugerencia-item');
        if (!el) return;
        const valor = el.getAttribute('data-valor');
        document.getElementById('input-busqueda').value = valor;
        ejecutarBusqueda(valor);
    };
}

function ocultarSugerencias() { document.getElementById('sugerencias-box').classList.add('oculto'); }

// --- 5. ENCUADRE, ZOOM Y PAN/DRAG (Pointer Events + clamping) ---

// Desfase entre el sistema de coordenadas del lienzo original y el área recortada (0 si no hay recorte)
let desfaseX = 0;
let desfaseY = 0;
let bboxOriginal = { w: 0, h: 0 };
let panelCalibrar = null;
let cursorCalibrar = null;

// Los límites son el viewBox original del SVG (no getBBox(), que incluye trazos que sobresalen del marco).
// El SVG de Inkscape usa mm en el viewBox y px en width/height: se trabaja en px (1 unidad = 1 px a escala 1).
function medirSVG() {
    const vb = svgEl.viewBox.baseVal;
    const anchoPx = parseFloat(svgEl.getAttribute('width')) || 2000;
    const altoPx = parseFloat(svgEl.getAttribute('height')) || 1818;
    const vx = vb.x || 0, vy = vb.y || 0;
    const vw = vb.width || anchoPx, vh = vb.height || altoPx;
    const kx = vw / anchoPx;   // unidades del viewBox por px
    const ky = vh / altoPx;
    const r = LIMITES_CONFIG.recorte;

    bboxOriginal = { w: anchoPx, h: altoPx };
    desfaseX = r.izq;
    desfaseY = r.arriba;
    anchoRealSVG = Math.max(1, anchoPx - r.izq - r.der);
    altoRealSVG = Math.max(1, altoPx - r.arriba - r.abajo);

    vistaBase = { x: vx + r.izq * kx, y: vy + r.arriba * ky, kx, ky };
    svgEl.setAttribute('viewBox', `${vistaBase.x} ${vistaBase.y} ${anchoRealSVG * kx} ${altoRealSVG * ky}`);
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    if (RENDER_CONFIG.modo === 'viewbox') {
        svgEl.setAttribute('preserveAspectRatio', 'none'); // la proporción ya coincide con la pantalla: no hay franjas
        svgEl.style.width = '100%';
        svgEl.style.height = '100%';
    } else {
        svgEl.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        svgEl.style.width = anchoRealSVG + 'px';
        svgEl.style.height = altoRealSVG + 'px';
    }
}

function calcularEscalas() {
    const ex = anchoContenedor / anchoRealSVG;
    const ey = altoContenedor / altoRealSVG;
    escalaMinimaPermitida = LIMITES_CONFIG.modoMinimo === 'contener' ? Math.min(ex, ey) : Math.max(ex, ey);
    escalaMaximaPermitida = Math.max(LIMITES_CONFIG.zoomMaximo, escalaMinimaPermitida * 2);
}

function limitarEscala(e) {
    return Math.min(escalaMaximaPermitida, Math.max(escalaMinimaPermitida, e));
}

// Límites herméticos: el mapa nunca deja ver fondo vacío (o se centra si es más chico que la pantalla).
function limitarTraslacion() {
    const w = anchoRealSVG * escala;
    const h = altoRealSVG * escala;
    transX = w <= anchoContenedor ? (anchoContenedor - w) / 2
                                  : Math.min(0, Math.max(anchoContenedor - w, transX));
    transY = h <= altoContenedor ? (altoContenedor - h) / 2
                                 : Math.min(0, Math.max(altoContenedor - h - margenInferiorHoja(), transY));
}

// Vista inicial según VISTA_INICIAL_CONFIG, en coordenadas del mapa (no modifica la vista actual)
function calcularVistaInicial() {
    const cfg = VISTA_INICIAL_CONFIG;
    let c = { x: anchoRealSVG / 2, y: altoRealSVG / 2 };
    const elFoco = cfg.enfocarId && document.getElementById(cfg.enfocarId);
    if (elFoco) {
        renderizarAhora(); // el DOM refleja la vista actual antes de medir
        const re = elFoco.getBoundingClientRect();
        const rc = contenedorMapa.getBoundingClientRect();
        c = { x: (re.left + re.width / 2 - rc.left - transX) / escala, y: (re.top + re.height / 2 - rc.top - transY) / escala };
    } else if (cfg.centro) {
        c = { x: cfg.centro.x - desfaseX, y: cfg.centro.y - desfaseY };
    }
    return { escala: limitarEscala(escalaMinimaPermitida * Math.max(1, cfg.zoom)), cx: c.x, cy: c.y };
}

function establecerVistaInicial() {
    const v = calcularVistaInicial();
    escala = v.escala;
    transX = anchoContenedor / 2 - v.cx * escala;
    transY = altoContenedor / 2 - v.cy * escala;
}

function renderizarAhora() {
    if (RENDER_CONFIG.modo === 'viewbox') {
        if (!anchoContenedor || !altoContenedor) return;
        // La misma relación pantalla = traslación + escala * mapa, expresada como ventana (viewBox) sobre el mapa
        const v = vistaBase;
        svgEl.setAttribute('viewBox', [
            (v.x - transX / escala * v.kx).toFixed(4), (v.y - transY / escala * v.ky).toFixed(4),
            (anchoContenedor / escala * v.kx).toFixed(4), (altoContenedor / escala * v.ky).toFixed(4)
        ].join(' '));
    } else {
        svgEl.style.transform = `translate(${transX}px, ${transY}px) scale(${escala})`;
    }
    actualizarEstadoControles();
    if (gpsEstado.activo) ajustarTamanoMarcadorGPS();
    if (panelCalibrar) actualizarPanelCalibrar();
}

// El estado se corrige al instante; el DOM se escribe como máximo una vez por frame.
function aplicarTransformacionSVG() {
    limitarTraslacion();
    if (renderPendiente) return;
    renderPendiente = true;
    requestAnimationFrame(() => {
        renderPendiente = false;
        renderizarAhora();
    });
}

// Zoom manteniendo fijo el punto (px, py) de la pantalla. Primero se limita la escala y luego
// se calcula la traslación, así el punto focal y los límites nunca se contradicen.
function zoomHacia(px, py, nuevaEscala) {
    const s = limitarEscala(nuevaEscala);
    const r = s / escala;
    transX = px - (px - transX) * r;
    transY = py - (py - transY) * r;
    escala = s;
    aplicarTransformacionSVG();
}

function datosPellizco() {
    const [a, b] = punteros.values();
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

function inicializarPanZoom() {
    contenedorMapa = document.getElementById('modulo-mapa');
    svgEl = document.getElementById('svg1');
    if (!contenedorMapa || !svgEl) return;

    medirSVG();
    if (new URLSearchParams(location.search).has('calibrar')) iniciarCalibrador();

    // ResizeObserver: mide el contenedor solo cuando cambia (sin leer el layout en cada frame)
    new ResizeObserver(entries => {
        const { width, height } = entries[0].contentRect;
        if (!width || !height) return;
        anchoContenedor = width;
        altoContenedor = height;
        const relativo = mapaInicializado ? escala / escalaMinimaPermitida : 1;
        calcularEscalas();
        if (!mapaInicializado) {
            establecerVistaInicial();
            mapaInicializado = true;
        } else {
            escala = limitarEscala(escalaMinimaPermitida * relativo);
        }
        aplicarTransformacionSVG();
        if (!cargaInicialTerminada) { // dos fotogramas: el mapa ya está dibujado antes de quitar la pantalla de carga
            cargaInicialTerminada = true;
            requestAnimationFrame(() => requestAnimationFrame(ocultarCarga));
        }
    }).observe(contenedorMapa);

    // Rueda / trackpad: zoom exponencial hacia el cursor
    contenedorMapa.addEventListener('wheel', (e) => {
        e.preventDefault();
        cancelarAnimacionVista();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;        // líneas -> px (Firefox)
        else if (e.deltaMode === 2) dy *= 400;  // páginas -> px
        dy = Math.max(-120, Math.min(120, dy)); // evita saltos bruscos
        const rect = contenedorMapa.getBoundingClientRect();
        zoomHacia(e.clientX - rect.left, e.clientY - rect.top, escala * Math.exp(-dy * LIMITES_CONFIG.velocidadRueda));
    }, { passive: false });

    contenedorMapa.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        cancelarAnimacionVista();
        contenedorMapa.setPointerCapture(e.pointerId);
        punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (punteros.size === 1) {
            inicioToque = { x: e.clientX, y: e.clientY };
            huboArrastre = false;
            huboMultitouch = false;
        } else if (punteros.size === 2) {
            huboMultitouch = true;
            ultimoPellizco = datosPellizco();
        }
    });

    contenedorMapa.addEventListener('pointermove', (e) => {
        const p = punteros.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;

        if (punteros.size === 1) {
            if (!huboArrastre && Math.hypot(e.clientX - inicioToque.x, e.clientY - inicioToque.y) > 6) huboArrastre = true;
            transX += dx;
            transY += dy;
            aplicarTransformacionSVG();
        } else if (punteros.size >= 2) {
            // Pellizco incremental: desplaza por el movimiento del centro y escala hacia él
            const nuevo = datosPellizco();
            if (ultimoPellizco && ultimoPellizco.dist > 0 && nuevo.dist > 0) {
                const rect = contenedorMapa.getBoundingClientRect();
                transX += nuevo.cx - ultimoPellizco.cx;
                transY += nuevo.cy - ultimoPellizco.cy;
                zoomHacia(nuevo.cx - rect.left, nuevo.cy - rect.top, escala * nuevo.dist / ultimoPellizco.dist);
            }
            ultimoPellizco = nuevo;
        }
    });

    const terminarPuntero = (e) => {
        if (!punteros.delete(e.pointerId)) return;
        ultimoPellizco = null;
        if (punteros.size === 0) {
            if (e.type === 'pointerup' && !huboArrastre && !huboMultitouch) manejarToqueEnMapa(e.clientX, e.clientY);
            huboMultitouch = false;
        }
    };
    contenedorMapa.addEventListener('pointerup', terminarPuntero);
    contenedorMapa.addEventListener('pointercancel', terminarPuntero);
}

// Toque/clic sin arrastre: selecciona un salón o, si fue en vacío, cierra el panel.
function manejarToqueEnMapa(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    // Sube por los ancestros hasta hallar un salón registrado (los paths internos de Inkscape traen ids propios)
    for (let nodo = el; nodo && nodo !== svgEl; nodo = nodo.parentElement) {
        if (salonesRegistradosEnMapa.has(nodo.id)) {
            seleccionarSalon(nodo.id);
            return;
        }
    }
    if (el === contenedorMapa || el === svgEl || el.classList.contains('mapa-placeholder')) cerrarPanelResultados();
}

function procesarEstructuras() {
    estructuraPorId.clear();
    estructuraPorSalon.clear();
    escuelaPorIdEdificio.clear();

    // Primero identificamos las escuelas globales (las que tienen múltiples ids o nombres limpios sin "- Edificio")
    const escuelasGlobales = estructurasConfig.estructuras.filter(e => !esEdificioDeEscuela(e));

    estructurasConfig.estructuras.forEach(est => {
        est.ids = (est.ids || []).filter(id => {
            const el = document.getElementById(id);
            if (!el) { console.warn(`⚠️ estructuras.json: no existe el id "${id}" en el SVG (${est.nombre})`); return false; }
            if (!salonesRegistradosEnMapa.has(id)) {
                salonesRegistradosEnMapa.add(id);
                elementosSalon.set(id, el);
                el.classList.add('salon');
                el.style.cursor = 'pointer';
            }
            return true;
        });

        est.ids.forEach(id => {
            estructuraPorId.set(id, est);
            
            // Si este edificio pertenece a una escuela con varios edificios, 
            // asociamos su ID al objeto de la escuela global correspondiente para resaltarlos todos juntos al tocarlo.
            const escuelaGlobal = escuelasGlobales.find(g => g.tipo === 'escuela' && g.ids.includes(id) && g.nombre !== est.nombre);
            if (escuelaGlobal) {
                escuelaPorIdEdificio.set(id, escuelaGlobal);
            }
        });

        // Vinculamos los salones específicos a este edificio en particular
        (est.salones || []).forEach(s => estructuraPorSalon.set(String(s).trim().toUpperCase(), est));
    });
}

// Al tocar un elemento directamente en el mapa
function seleccionarSalon(idSalon) {
    const panelActivo = document.getElementById('modulo-resultados').classList.contains('activo') ||
                        document.getElementById('panel-info').classList.contains('activo');
    if (salonActivoActual === idSalon && panelActivo) {
        cerrarPanelResultados();
        return;
    }
    
    salonActivoActual = idSalon;

    // PRIORIDAD 1: Si el ID pertenece a un edificio de una escuela múltiple, 
    // mostramos la escuela global y resaltamos TODOS sus edificios a la vez.
    const escuelaGlobal = escuelaPorIdEdificio.get(idSalon);
    if (escuelaGlobal) {
        mostrarInfoEstructura(escuelaGlobal, { encuadrar: false });
        return;
    }

    // PRIORIDAD 2: Si es una estructura normal (departamento, cantina, decanato, etc.)
    const est = estructuraPorId.get(idSalon);
    if (est) {
        mostrarInfoEstructura(est, { encuadrar: false });
        return;
    }

    // PRIORIDAD 3: Si es un salón suelto, ejecutamos la búsqueda normal
    document.getElementById('input-busqueda').value = idSalon;
    ejecutarBusqueda(idSalon, { encuadrar: false, soloSalon: true });
}

// Vista actual en coordenadas del SVG original (las mismas que usan 'centro' y 'recorte')
function calcularVistaActual() {
    return {
        zoom: +(escala / escalaMinimaPermitida).toFixed(2),
        centro: {
            x: Math.round((anchoContenedor / 2 - transX) / escala + desfaseX),
            y: Math.round((altoContenedor / 2 - transY) / escala + desfaseY)
        }
    };
}
window.vistaActual = () => {
    const r = calcularVistaActual();
    console.log(JSON.stringify(r));
    return r;
};

// Modo calibración: abre la página con  index.html?calibrar
function iniciarCalibrador() {
    panelCalibrar = document.createElement('div');
    panelCalibrar.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2000;background:rgba(0,0,0,.82);color:#fff;font:12px/1.5 monospace;padding:8px 12px;border-radius:8px;pointer-events:none;white-space:pre';
    document.body.appendChild(panelCalibrar);
    contenedorMapa.addEventListener('pointermove', (e) => { cursorCalibrar = { x: e.clientX, y: e.clientY }; actualizarPanelCalibrar(); });
}

function actualizarPanelCalibrar() {
    const v = calcularVistaActual();
    let lineaCursor = 'cursor: (mueve el mouse sobre el mapa)';
    if (cursorCalibrar) {
        const rect = contenedorMapa.getBoundingClientRect();
        const mx = Math.round((cursorCalibrar.x - rect.left - transX) / escala + desfaseX);
        const my = Math.round((cursorCalibrar.y - rect.top - transY) / escala + desfaseY);
        lineaCursor = `cursor: x=${mx}  y=${my}`;
    }
    panelCalibrar.textContent =
        `${lineaCursor}\n` +
        `vista:  zoom: ${v.zoom}, centro: { x: ${v.centro.x}, y: ${v.centro.y} }\n` +
        `SVG original: ${Math.round(bboxOriginal.w)} x ${Math.round(bboxOriginal.h)}  |  recortado: ${Math.round(anchoRealSVG)} x ${Math.round(altoRealSVG)}`;
}

// --- 5.2 ZOOM Y PAN AUTOMÁTICOS (hacia lo buscado o resaltado) ---
let animacionVista = null;
let escalaObjetivoVista = null; // zoom al que va la animación en curso (para encadenar clics en + / −)

function cancelarAnimacionVista() {
    if (animacionVista) { cancelAnimationFrame(animacionVista); animacionVista = null; }
    escalaObjetivoVista = null;
}

// Anima la vista hasta que el punto (cx, cy) del mapa quede en (ax, ay) de la pantalla con la escala indicada.
// Cada fotograma pasa por limitarTraslacion(): la animación nunca se sale de los bordes del mapa.
function animarVista(escalaFin, cx, cy, ax, ay, duracion = ENCUADRE_CONFIG.duracion) {
    cancelarAnimacionVista();
    escalaFin = limitarEscala(escalaFin);
    escalaObjetivoVista = escalaFin;
    const e0 = escala;
    const c0x = (ax - transX) / e0; // punto del mapa que hoy está en (ax, ay)
    const c0y = (ay - transY) / e0;
    const reducirMovimiento = ENCUADRE_CONFIG.respetarMovimientoReducido &&
        window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sinAnimacion = duracion <= 0 || reducirMovimiento;
    const t0 = performance.now();

    const paso = (ahora) => {
        const t = sinAnimacion ? 1 : Math.min(1, (ahora - t0) / duracion);
        const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out
        escala = e0 * Math.pow(escalaFin / e0, k);                           // el zoom se interpola en escala logarítmica
        transX = ax - (c0x + (cx - c0x) * k) * escala;
        transY = ay - (c0y + (cy - c0y) * k) * escala;
        limitarTraslacion();
        renderizarAhora();
        animacionVista = t < 1 ? requestAnimationFrame(paso) : null;
        if (t >= 1) escalaObjetivoVista = null;
    };
    animacionVista = requestAnimationFrame(paso);
}

// Ventana de ancho W x alto H (unidades del mapa) que contiene más elementos; en empate, la más compacta.
function ventanaMasDensa(items, W, H) {
    let mejor = [], mejorArea = Infinity;
    for (const a of items) {
        for (const b of items) {
            const dentro = items.filter(i => i.cx >= a.cx && i.cx <= a.cx + W && i.cy >= b.cy && i.cy <= b.cy + H);
            if (dentro.length < mejor.length) continue;
            const area = (Math.max(...dentro.map(i => i.x1)) - Math.min(...dentro.map(i => i.x0))) *
                         (Math.max(...dentro.map(i => i.y1)) - Math.min(...dentro.map(i => i.y0)));
            if (dentro.length > mejor.length || area < mejorArea) { mejor = dentro; mejorArea = area; }
        }
    }
    return mejor;
}

// Decide qué encuadrar y con qué zoom:
//  - si todos los elementos caben con un zoom cómodo, se encuadran todos;
//  - si no, se elige la zona de mayor densidad (la ventana de pantalla con más elementos).
// El resultado siempre queda entre el zoom mínimo (mapa completo) y el máximo.
function calcularEncuadre(items, anchoUtil, altoUtil) {
    const caja = g => ({
        x0: Math.min(...g.map(i => i.x0)), y0: Math.min(...g.map(i => i.y0)),
        x1: Math.max(...g.map(i => i.x1)), y1: Math.max(...g.map(i => i.y1))
    });
    const escalaPara = g => {
        const c = caja(g);
        return Math.min(anchoUtil / Math.max(c.x1 - c.x0, 1), altoUtil / Math.max(c.y1 - c.y0, 1));
    };
    const escalaTope = Math.min(escalaMaximaPermitida, escalaMinimaPermitida * ENCUADRE_CONFIG.zoomMaximo);
    const escalaComoda = Math.min(escalaTope, Math.max(escalaMinimaPermitida, escalaMinimaPermitida * ENCUADRE_CONFIG.zoomBusqueda));

    let grupo = items;
    if (items.length > 1 && escalaPara(items) < escalaComoda) {
        grupo = ventanaMasDensa(items, anchoUtil / escalaComoda, altoUtil / escalaComoda);
    }
    const c = caja(grupo);
    return {
        escala: Math.min(escalaTope, Math.max(escalaMinimaPermitida, escalaPara(grupo))),
        cx: (c.x0 + c.x1) / 2,
        cy: (c.y0 + c.y1) / 2,
        usados: grupo.length
    };
}

// Zona de pantalla libre de buscador y del panel de horarios (solo si es un panel lateral en pantalla ancha)
function areaVisibleMapa() {
    let x0 = 0;
    const panel = document.getElementById('modulo-resultados');
    if (esVistaMovil()) { // hoja inferior: el mapa útil es lo que queda sobre ella
        const activa = panel.classList.contains('activo');
        const estado = estadoHoja();
        let y1 = altoContenedor;
        if (activa && estado === 'asomada') y1 = altoContenedor * (1 - HOJA_MOVIL.alturaAsomada) - 10;
        else if (activa && estado === 'baja') y1 = altoContenedor - HOJA_MOVIL.alturaBajaPx - 10;
        return { x0: 0, y0: 80, x1: anchoContenedor, y1 };
    }
    if (panel.classList.contains('activo') && !panel.classList.contains('minimizado')) {
        const borde = panel.offsetLeft + panel.offsetWidth;
        if (borde < anchoContenedor * 0.6) x0 = borde + 10; // en el móvil el panel cubre todo: se ignora y se oculta con la pestaña
    }
    return { x0, y0: 80, x1: anchoContenedor, y1: altoContenedor };
}

// Centra en pantalla los elementos indicados (un salón, una estructura o muchos resaltados)
function encuadrarElementos(elementos) {
    if (!svgEl || !mapaInicializado) return;
    const lista = Array.from(elementos || []);
    if (lista.length === 0) return;

    cancelarAnimacionVista();
    renderizarAhora(); // el DOM refleja el estado actual antes de medir
    const rc = contenedorMapa.getBoundingClientRect();
    const items = [];
    lista.forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const x0 = (r.left - rc.left - transX) / escala, x1 = (r.right - rc.left - transX) / escala;
        const y0 = (r.top - rc.top - transY) / escala, y1 = (r.bottom - rc.top - transY) / escala;
        items.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    });
    if (items.length === 0) return;

    const area = areaVisibleMapa();
    const ancho = area.x1 - area.x0, alto = area.y1 - area.y0;
    const m = Math.min(ENCUADRE_CONFIG.margen, 0.12 * Math.min(ancho, alto));
    const enc = calcularEncuadre(items, Math.max(50, ancho - 2 * m), Math.max(50, alto - 2 * m));
    animarVista(enc.escala, enc.cx, enc.cy, (area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2);
}

// --- 5.3 BOTÓN "ATRÁS" DEL TELÉFONO: cierra menú/horarios/info en vez de salir de la página ---
const Historial = { sentinela: false, ignorar: 0, pendiente: null, abrirPendiente: false };

function hayCapasAbiertas() {
    return ['panel-opciones', 'modulo-resultados', 'panel-info']
        .some(id => document.getElementById(id).classList.contains('activo'));
}

// Al abrir un menú/panel se añade una entrada al historial: "atrás" la consume y cierra lo abierto
function abrirCapaHistorial() {
    if (Historial.sentinela) return;
    Historial.sentinela = true;
    if (Historial.ignorar > 0) { Historial.abrirPendiente = true; return; } // hay un back() en curso: la entrada se añade cuando termine
    history.pushState({ geofacing: true }, '');
}

// Tras cerrar por la interfaz (botón X, tocar el mapa...) retira la entrada extra si ya no queda nada abierto.
// Va diferido para no encadenar back() + push() cuando un panel simplemente se reemplaza por otro.
function sincronizarHistorial() {
    clearTimeout(Historial.pendiente);
    Historial.pendiente = setTimeout(() => {
        if (!Historial.sentinela || hayCapasAbiertas()) return;
        Historial.sentinela = false;
        if (Historial.abrirPendiente) { Historial.abrirPendiente = false; return; } // la entrada aún no se había añadido
        Historial.ignorar++;
        history.back();
    }, 0);
}

window.addEventListener('popstate', () => {
    if (Historial.ignorar > 0) { // fue nuestro propio back()
        Historial.ignorar--;
        if (Historial.ignorar === 0 && Historial.abrirPendiente) {
            Historial.abrirPendiente = false;
            history.pushState({ geofacing: true }, '');
        }
        return;
    }
    Historial.sentinela = false;                                // el navegador consumió la entrada
    Historial.abrirPendiente = false;
    if (!hayCapasAbiertas()) return;                            // nada abierto: deja salir de la página
    if (document.getElementById('panel-opciones').classList.contains('activo')) cerrarMenuDrawer();
    else cerrarPanelResultados();
    if (hayCapasAbiertas()) abrirCapaHistorial();               // queda algo abierto (p. ej. horarios bajo el menú)
});

// --- 5.5 ESTRUCTURAS (escuelas, departamentos, cantinas, baños...) ---
// Quita acentos y pasa a mayúsculas para comparar textos ("Dirección" == "direccion")
function plegar(texto) {
    return (texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

async function cargarEstructuras() {
    try {
        const datos = await pedir('./estructuras.json');
        if (!datos || !Array.isArray(datos.estructuras)) throw new ErrorCarga('formato', 'El archivo de lugares no tiene un formato válido.');

        estructurasConfig = { tipos: datos.tipos || {}, estructuras: datos.estructuras };

        // Aquí es donde integramos la lectura de los salones excluidos del JSON
        salonesExcluidosSet = new Set((datos.salonesExcluidosLibres || []).map(s => s.trim().toUpperCase()));
        estructurasListas = true;
        return null;
    } catch (error) {
        console.error("❌ Error al cargar estructuras.json:", error);
        return error;
    }
}

// Ventana pequeña con el nombre + resaltado en el mapa. Acepta una estructura o varias con el mismo nombre
function mostrarInfoEstructura(estructuras, opciones = {}) {
    const lista = Array.isArray(estructuras) ? estructuras : [estructuras];
    const primera = lista[0];
    ocultarSugerencias();
    ocultarPaneles();
    limpiarResaltadoMapa();
    document.getElementById('input-busqueda').value = primera.nombre;
    lista.forEach(est => est.ids.forEach(id => marcarSalon(id, 'salon-resaltado')));
    const tipo = estructurasConfig.tipos[primera.tipo] || {};
    const cuantas = lista.length > 1 ? ` · ${lista.length} en el mapa` : '';
    document.getElementById('info-tipo').textContent = (tipo.etiqueta || 'Lugar') + cuantas;
    document.getElementById('info-nombre').textContent = primera.nombre;
    document.getElementById('panel-info').classList.add('activo');
    abrirCapaHistorial();
    if (opciones.encuadrar !== false) encuadrarElementos(elementosResaltados);
}

// Resalta todas las estructuras de un tipo (cantinas, baños, papelerías...)
function resaltarEstructurasPorTipo(clave) {
    const tipo = estructurasConfig.tipos[clave] || {};
    const lista = estructurasConfig.estructuras.filter(e => e.tipo === clave && e.ids.length);
    limpiarResaltadoMapa();
    if (lista.length === 0) {
        mostrarAviso(`No hay ${(tipo.plural || tipo.etiqueta || 'lugares').toLowerCase()} registrados en el mapa.`);
        cerrarMenuDrawer();
        return;
    }
    ocultarPaneles();
    lista.forEach(e => e.ids.forEach(id => marcarSalon(id, 'salon-resaltado')));
    cerrarMenuDrawer();
    encuadrarElementos(elementosResaltados);
}

// Opciones del menú: salones libres + los tipos marcados como "buscable" en estructuras.json
function construirOpcionesBusqueda() {
    const contenedor = document.getElementById('opciones-busqueda');
    if (!contenedor) return;
    const opciones = [{ valor: 'salones-libres', etiqueta: '⚡ Salones libres ahora' }];
    Object.entries(estructurasConfig.tipos).forEach(([clave, t]) => {
        if (t.buscable) opciones.push({ valor: clave, etiqueta: `${t.icono || '📍'} ${t.plural || t.etiqueta}` });
    });
    const filtro = document.getElementById('filtro-duracion');
    contenedor.onchange = () => {
        const marcada = document.querySelector('input[name="tipo-busqueda"]:checked');
        if (filtro) filtro.hidden = !marcada || marcada.value !== 'salones-libres';
    };
    contenedor.innerHTML = opciones.map((o, i) =>
        `<label class="opcion-busqueda"><input type="radio" name="tipo-busqueda" value="${o.valor}"${i === 0 ? ' checked' : ''}><span>${o.etiqueta}</span></label>`
    ).join('');
}

function resaltarSeleccion() {
    const marcada = document.querySelector('input[name="tipo-busqueda"]:checked');
    const valor = marcada ? marcada.value : 'salones-libres';
    if (valor === 'salones-libres') resaltarSalonesLibresAhora();
    else resaltarEstructurasPorTipo(valor);
}

// --- 6. CÁLCULO DE HORA CARACAS (UTC-4) Y SALONES DISPONIBLES ---
function obtenerTiempoCaracas() {
    if (MODO_PRUEBA) return { diaClave: PROBAR_DIA, totalMinutos: parseBloqueAMinutos(PROBAR_BLOQUE) };

    const ahora = new Date();
    const opciones = { timeZone: 'America/Caracas', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' };
    const formateador = new Intl.DateTimeFormat('es-VE', opciones);
    const partes = formateador.formatToParts(ahora);

    let diaTexto = '', hora = 0, minutos = 0;
    partes.forEach(p => {
        if (p.type === 'weekday') diaTexto = p.value.toLowerCase();
        if (p.type === 'hour') hora = parseInt(p.value, 10);
        if (p.type === 'minute') minutos = parseInt(p.value, 10);
    });

    const equivalenciasDias = {
        'lun': 'LU', 'lun.': 'LU', 'mar': 'MA', 'mar.': 'MA',
        'mié': 'MI', 'mié.': 'MI', 'mie': 'MI', 'jue': 'JU', 'jue.': 'JU',
        'vie': 'VI', 'vie.': 'VI', 'sáb': 'SA', 'sáb.': 'SA', 'sab': 'SA'
    };

    return { diaClave: equivalenciasDias[diaTexto] || 'LU', totalMinutos: hora * 60 + minutos };
}

function parseBloqueAMinutos(bloqueStr) {
    return parseInt(bloqueStr.substring(0, 2), 10) * 60 + parseInt(bloqueStr.substring(2, 4), 10);
}

// Bloques de clase de la UC: cada uno dura 50 minutos y empieza donde termina el anterior
const BLOQUES_HORARIO = [
    { clave: "0800", inicio: 480 },  { clave: "0850", inicio: 530 },  { clave: "0940", inicio: 580 },
    { clave: "1030", inicio: 630 },  { clave: "1120", inicio: 680 },  { clave: "1210", inicio: 730 },
    { clave: "1300", inicio: 780 },  { clave: "1350", inicio: 830 },  { clave: "1440", inicio: 880 },
    { clave: "1530", inicio: 930 },  { clave: "1620", inicio: 980 },  { clave: "1710", inicio: 1030 },
    { clave: "1800", inicio: 1080 }, { clave: "1850", inicio: 1130 }, { clave: "1940", inicio: 1180 }
];
const DURACION_BLOQUE = 50;

function obtenerBloqueHoraActual() {
    if (MODO_PRUEBA) return PROBAR_BLOQUE;
    const { totalMinutos } = obtenerTiempoCaracas();
    const bloque = BLOQUES_HORARIO.find(b => totalMinutos >= b.inicio && totalMinutos < b.inicio + DURACION_BLOQUE);
    return bloque ? bloque.clave : null;
}

function horaTexto(minutos) {
    return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

// "DIA|SALON" -> bloques en los que ese salón tiene clase (se construye una sola vez)
let ocupacionPorSalon = null;
function construirIndiceOcupacion() {
    ocupacionPorSalon = new Map();
    baseDeDatosHorarios.forEach(bloque => {
        const [, , , , dia, hora, salon] = bloque;
        if (!salon) return;
        const clave = `${dia}|${salon.trim().toUpperCase()}`;
        if (!ocupacionPorSalon.has(clave)) ocupacionPorSalon.set(clave, new Set());
        ocupacionPorSalon.get(clave).add(hora);
    });
}

// Estado de un salón ahora mismo: { libre, hasta (minutos del día; null = el resto del día), minutosRestantes }
// Devuelve null fuera del horario de clases.
function estadoSalonAhora(idSalon) {
    const claveActual = obtenerBloqueHoraActual();
    if (!claveActual) return null;
    if (!ocupacionPorSalon) construirIndiceOcupacion();

    const { diaClave, totalMinutos } = obtenerTiempoCaracas();
    const ocupados = ocupacionPorSalon.get(`${diaClave}|${idSalon}`) || new Set();
    const libre = !ocupados.has(claveActual);

    // Avanza mientras el salón siga en el mismo estado
    let k = BLOQUES_HORARIO.findIndex(b => b.clave === claveActual) + 1;
    while (k < BLOQUES_HORARIO.length && ocupados.has(BLOQUES_HORARIO[k].clave) === !libre) k++;

    let hasta;
    if (k < BLOQUES_HORARIO.length) hasta = BLOQUES_HORARIO[k].inicio;
    else hasta = libre ? null : BLOQUES_HORARIO[BLOQUES_HORARIO.length - 1].inicio + DURACION_BLOQUE;
    return { libre, hasta, minutosRestantes: hasta === null ? Infinity : hasta - totalMinutos };
}

// Franja de color con el estado del salón para la parte superior del panel de horarios
function generarBannerEstado(idSalon) {
    if (!horariosListos) return '';
    const estado = estadoSalonAhora(idSalon);
    if (!estado) return '';
    const base = estado.libre ? 'Libre ahora' : 'Ocupado ahora';
    const texto = estado.hasta === null ? `${base} · el resto del día` : `${base} · hasta las ${horaTexto(estado.hasta)}`;
    return `<div class="estado-salon ${estado.libre ? 'estado-libre' : 'estado-ocupado'}"><span class="estado-punto"></span>${texto}</div>`;
}

function resaltarSalonesLibresAhora() {
    limpiarResaltadoMapa();

    if (!horariosListos) { // sin horarios todos los salones parecerían libres: mejor avisar
        cerrarMenuDrawer();
        avisarHorariosNoDisponibles();
        return;
    }

    if (!obtenerBloqueHoraActual()) {
        mostrarAviso("En este momento estamos fuera del horario de clases en la UC (Caracas / Valencia).");
        cerrarMenuDrawer();
        return;
    }

    ocultarPaneles();
    const selector = document.getElementById('select-duracion');
    const minimo = selector ? parseInt(selector.value, 10) || 0 : 0; // minutos que deben seguir libres

    salonesRegistradosEnMapa.forEach(idSalon => {
        if (estructuraPorId.has(idSalon)) return;
        if (salonesExcluidosSet.has(idSalon)) return; // Salta los excluidos
        const estado = estadoSalonAhora(idSalon);
        if (estado && estado.libre && estado.minutosRestantes >= minimo) marcarSalon(idSalon, 'salon-libre');
    });
    cerrarMenuDrawer();

    if (elementosResaltados.size === 0) {
        mostrarAviso(minimo ? `No hay salones que sigan libres por ${minimo >= 60 ? minimo / 60 + ' h' : minimo + ' min'} o más.` : "No hay salones libres en este momento.");
        return;
    }
    encuadrarElementos(elementosResaltados);
}

// --- 7. MENÚ HAMBURGUESA / DRAWER ---
function inicializarMenuOpciones() {
    const btnHamburguesa = document.getElementById('btn-hamburguesa');
    const btnCerrarDrawer = document.getElementById('btn-cerrar-drawer');
    const overlay = document.getElementById('overlay-drawer');
    const btnResaltar = document.getElementById('btn-resaltar');

    if (btnHamburguesa) btnHamburguesa.addEventListener('click', () => {
        document.getElementById('panel-opciones').classList.add('activo');
        if (overlay) overlay.classList.add('activo');
        abrirCapaHistorial();
    });
    if (btnCerrarDrawer) btnCerrarDrawer.addEventListener('click', cerrarMenuDrawer);
    if (overlay) overlay.addEventListener('click', cerrarMenuDrawer);
    if (btnResaltar) btnResaltar.addEventListener('click', resaltarSeleccion);
}

function cerrarMenuDrawer() {
    const panel = document.getElementById('panel-opciones');
    const overlay = document.getElementById('overlay-drawer');
    if (panel) panel.classList.remove('activo');
    if (overlay) overlay.classList.remove('activo');
    sincronizarHistorial();
}

// --- 5.4 CONTROLES DE ZOOM (+ / − / vista inicial) ---
const FACTOR_ZOOM_BOTON = 1.5;
const controles = { mas: null, menos: null, inicial: null, max: null, min: null };

function inicializarControlesMapa() {
    controles.mas = document.getElementById('btn-zoom-mas');
    controles.menos = document.getElementById('btn-zoom-menos');
    controles.inicial = document.getElementById('btn-vista-inicial');
    if (!controles.mas) return;
    controles.mas.addEventListener('click', () => zoomConBoton(FACTOR_ZOOM_BOTON));
    controles.menos.addEventListener('click', () => zoomConBoton(1 / FACTOR_ZOOM_BOTON));
    // En teléfono este botón es el de «Mi ubicación» (ver inicializarUbicacionGPS); sin GPS conserva su función original
    if (!gpsDisponible()) controles.inicial.addEventListener('click', volverAVistaInicial);
}

// Los botones nacen desactivados; se activan con el primer dibujo y se desactivan en el zoom mínimo/máximo
function actualizarEstadoControles() {
    if (!controles.mas) return;
    const enMax = escala >= escalaMaximaPermitida - 1e-4;
    const enMin = escala <= escalaMinimaPermitida + 1e-4;
    if (enMax !== controles.max) { controles.max = enMax; controles.mas.disabled = enMax; }
    if (enMin !== controles.min) { controles.min = enMin; controles.menos.disabled = enMin; }
    if (controles.inicial.disabled) controles.inicial.disabled = false;
}

// Punto de la pantalla alrededor del cual se hace zoom: el centro de la zona libre (descuenta el panel lateral si está abierto)
function centroDeVista() {
    const area = areaVisibleMapa();
    return { x: (area.x0 + anchoContenedor) / 2, y: altoContenedor / 2 };
}

function zoomConBoton(factor) {
    if (!mapaInicializado) return;
    const base = (animacionVista && escalaObjetivoVista) ? escalaObjetivoVista : escala; // varios clics seguidos se acumulan
    const destino = limitarEscala(base * factor);
    if (Math.abs(destino - base) < 1e-9) return;
    const c = centroDeVista();
    animarVista(destino, (c.x - transX) / escala, (c.y - transY) / escala, c.x, c.y, ENCUADRE_CONFIG.duracionBotones);
}

function volverAVistaInicial() {
    if (!mapaInicializado) return;
    const v = calcularVistaInicial();
    const c = centroDeVista();
    animarVista(v.escala, v.cx, v.cy, c.x, c.y);
}

// ===========================================================================
// UBICACIÓN POR GPS (punto azul sobre el mapa)
// ===========================================================================
const GPS_CONFIG = {
    soloMovil: true,       // true = el botón solo aparece en teléfono/tableta (en computadora la ubicación es muy imprecisa)
    margenZonaPx: 120,     // px (con el mapa a 2000 px de ancho) fuera de los puntos de calibración donde aún se dibuja el punto
    precisionMaxima: 100,  // m: se ignoran las lecturas con peor precisión que esta
    zoomAlActivar: 2.5,    // zoom (relativo al mapa completo = 1) al centrar la primera vez
    radioPuntoPx: 7,       // tamaño del punto azul en pantalla (no cambia con el zoom)
    suavizado: true,       // filtra el «baile» del GPS (promedia lecturas según su precisión)
    velocidadMax: 3,       // m/s: cuánto puede moverse una persona; más alto = el punto sigue más rápido pero salta más
    errorMinimoM: 12       // m: el GPS a veces dice «±2 m» y se equivoca 15 m (rebotes junto a edificios). Se usa como mínimo en el círculo y en el suavizado
};
const VERSION_GPS = 'gps-5'; // sale en el panel ?gpsdebug: sirve para confirmar qué código está corriendo el teléfono

// Puntos de calibración: [nombre, longitud, latitud, x, y]
//   longitud/latitud: sacadas de Google Maps (vista satélite). x, y: píxeles del mapa con 2000 px de ancho (?calibrar).
// Para corregir un punto basta con cambiar su fila; el ajuste se recalcula solo.
const GPS_PUNTOS = [
    ['1', -68.018392, 10.278109, 40.89, 312.55],
    ['2', -68.017232, 10.278497, 582.7, 113.18],
    ['3', -68.0161, 10.278612, 1061.85, 99.84],
    ['4', -68.015372, 10.27852, 1339.13, 154.1],
    ['5', -68.014663, 10.278225, 1621.7, 290.41],
    ['6', -68.015207, 10.277947, 1391.18, 388.1],
    ['7', -68.015774, 10.277948, 1170.26, 381.25],
    ['8', -68.016676, 10.277877, 799.77, 380.89],
    ['9', -68.016879, 10.278141, 731.53, 274.04],
    ['10', -68.017434, 10.277395, 468.45, 618.81],
    ['11', -68.016657, 10.277341, 803.07, 608.75],
    ['12', -68.016323, 10.277484, 942.0, 560.93],
    ['13', -68.015961, 10.277681, 1089.65, 481.83],
    ['14', -68.015746, 10.277373, 1172.73, 614.25],
    ['15', -68.015062, 10.277206, 1439.13, 708.49],
    ['16', -68.014509, 10.277231, 1672.29, 706.92],
    ['17', -68.015707, 10.276885, 1181.16, 815.39],
    ['18', -68.016862, 10.276678, 687.09, 906.68],
    ['19', -68.017323, 10.276881, 503.76, 816.95],
    ['20', -68.018119, 10.276761, 113.8, 832.87],
    ['21', -68.017591, 10.276425, 386.6, 1016.07],
    ['22', -68.0174, 10.276007, 461.77, 1163.58],
    ['23', -68.016953, 10.275903, 645.05, 1189.12],
    ['24', -68.016551, 10.27576, 797.68, 1276.82],
    ['25', -68.015901, 10.276001, 1040.45, 1190.45],
    ['26', -68.014071, 10.276339, 1736.4, 1130.55],
    ['27', -68.015529, 10.275329, 1156.47, 1480.72],
    ['28', -68.016056, 10.275239, 949.52, 1513.42],
    ['29', -68.016555, 10.274749, 747.9, 1683.18],
    ['30', -68.017694, 10.274502, 243.96, 1753.65],
    ['a', -68.016182, 10.277916, 1006.1, 370.48],
    ['b', -68.014923, 10.277711, 1504.26, 496.2],
    ['c', -68.016118, 10.277085, 1026.18, 740.68],
    ['d', -68.016961, 10.274752, 544.2, 1668.58],
];

// <GPS-PURO>
const gpsModelo = { listo: false, valido: false };

function prepararModeloGPS() {
    if (gpsModelo.listo) return gpsModelo.valido;
    gpsModelo.listo = true;
    const P = GPS_PUNTOS;
    const lat0 = P.reduce((s, p) => s + p[2], 0) / P.length;
    const lon0 = P.reduce((s, p) => s + p[1], 0) / P.length;
    const kE = 111320 * Math.cos(lat0 * Math.PI / 180) / 100; // grados de longitud -> cientos de metros
    const kN = 110574 / 100;                                  // grados de latitud  -> cientos de metros
    const rasgos = (lon, lat) => {
        const e = (lon - lon0) * kE, n = (lat - lat0) * kN;
        return [e * e, e * n, n * n, e, n, 1];
    };
    // Ajuste cuadrático (x, y del mapa en función de lon, lat) por mínimos cuadrados: (FᵀF)c = FᵀQ
    const k = 6;
    const A = Array.from({ length: k }, () => new Array(k + 2).fill(0));
    P.forEach(p => {
        const f = rasgos(p[1], p[2]);
        for (let i = 0; i < k; i++) {
            for (let j = 0; j < k; j++) A[i][j] += f[i] * f[j];
            A[i][k] += f[i] * p[3];
            A[i][k + 1] += f[i] * p[4];
        }
    });
    for (let i = 0; i < k; i++) { // Gauss-Jordan con pivote parcial
        let m = i;
        for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
        [A[i], A[m]] = [A[m], A[i]];
        if (Math.abs(A[i][i]) < 1e-9) return false;
        for (let r = 0; r < k; r++) {
            if (r === i) continue;
            const f = A[r][i] / A[i][i];
            for (let c = i; c < k + 2; c++) A[r][c] -= f * A[i][c];
        }
    }
    gpsModelo.cx = A.map((fila, i) => fila[k] / fila[i]);
    gpsModelo.cy = A.map((fila, i) => fila[k + 1] / fila[i]);
    gpsModelo.rasgos = rasgos;
    gpsModelo.kE = kE; gpsModelo.kN = kN; gpsModelo.lon0 = lon0; gpsModelo.lat0 = lat0;
    const xs = P.map(p => p[3]), ys = P.map(p => p[4]), mg = GPS_CONFIG.margenZonaPx;
    gpsModelo.zona = { x0: Math.min(...xs) - mg, x1: Math.max(...xs) + mg, y0: Math.min(...ys) - mg, y1: Math.max(...ys) + mg };
    gpsModelo.valido = true;
    const o = gpsAPx(lon0, lat0), e = gpsAPx(lon0 + 1 / kE, lat0), n = gpsAPx(lon0, lat0 + 1 / kN); // 100 m al este y al norte
    gpsModelo.pxPorMetro = (Math.hypot(e.x - o.x, e.y - o.y) + Math.hypot(n.x - o.x, n.y - o.y)) / 200;
    return true;
}

// Longitud/latitud -> píxeles del mapa (a 2000 px de ancho)
function gpsAPx(lon, lat) {
    const f = gpsModelo.rasgos(lon, lat);
    let x = 0, y = 0;
    for (let i = 0; i < 6; i++) { x += gpsModelo.cx[i] * f[i]; y += gpsModelo.cy[i] * f[i]; }
    return { x, y };
}

// Filtro de Kalman sencillo: pondera cada lectura por su precisión y deja que la incertidumbre crezca con el tiempo
const gpsFiltro = { lat: null, lon: null, varianza: 0, t: 0 };
function reiniciarFiltroGPS() { gpsFiltro.lat = null; }
function filtrarPosicionGPS(lat, lon, precision, t) {
    const acc = Math.max(precision, GPS_CONFIG.errorMinimoM);
    if (!GPS_CONFIG.suavizado || gpsFiltro.lat === null) {
        Object.assign(gpsFiltro, { lat, lon, varianza: acc * acc, t });
        return { lat, lon };
    }
    const dt = Math.max(0, (t - gpsFiltro.t) / 1000);
    gpsFiltro.varianza += dt * GPS_CONFIG.velocidadMax * GPS_CONFIG.velocidadMax;
    const K = gpsFiltro.varianza / (gpsFiltro.varianza + acc * acc);
    gpsFiltro.lat += K * (lat - gpsFiltro.lat);
    gpsFiltro.lon += K * (lon - gpsFiltro.lon);
    gpsFiltro.varianza = (1 - K) * gpsFiltro.varianza;
    gpsFiltro.t = t;
    return { lat: gpsFiltro.lat, lon: gpsFiltro.lon };
}
// </GPS-PURO>

const gpsEstado = { activo: false, pausado: false, watchId: null, mapa: null, centrado: false, avisoFuera: false, avisoDebil: false };
let capaGPS = null;

function unidadesDePx(p) { // px del mapa a 2000 px -> unidades del SVG
    return {
        x: (vistaBase.x - desfaseX * vistaBase.kx) + p.x * vistaBase.kx,
        y: (vistaBase.y - desfaseY * vistaBase.ky) + p.y * vistaBase.ky
    };
}

function asegurarCapaGPS() {
    const svg = document.getElementById('svg1');
    if (!svg) return null;
    if (!capaGPS || !capaGPS.isConnected) {
        capaGPS = document.createElementNS(SVG_NS, 'g');
        capaGPS.setAttribute('pointer-events', 'none');
        capaGPS.innerHTML = '<circle class="gps-precision"/><circle class="gps-halo"/><circle class="gps-punto"/>';
        svg.appendChild(capaGPS);
    } else if (svg.lastChild !== capaGPS) {
        svg.appendChild(capaGPS); // siempre encima del resaltado
    }
    return capaGPS;
}

// El punto mantiene su tamaño en pantalla: se reescala con el zoom
function ajustarTamanoMarcadorGPS() {
    if (!capaGPS || !capaGPS.isConnected) return;
    const u = vistaBase.kx / escala; // unidades del SVG por píxel de pantalla
    const r = GPS_CONFIG.radioPuntoPx;
    const [, halo, punto] = capaGPS.children;
    halo.setAttribute('r', (r + 2.5) * u);
    punto.setAttribute('r', r * u);
}

function dibujarMarcadorGPS(p, precisionM) {
    const g = asegurarCapaGPS();
    if (!g) return;
    const c = unidadesDePx(p);
    const [prec, halo, punto] = g.children;
    const rPrec = Math.min(Math.max(precisionM, GPS_CONFIG.errorMinimoM), 80) * gpsModelo.pxPorMetro * vistaBase.kx; // círculo de error (entre el mínimo y 80 m)
    [prec, halo, punto].forEach(el => { el.setAttribute('cx', c.x); el.setAttribute('cy', c.y); });
    prec.setAttribute('r', rPrec);
    ajustarTamanoMarcadorGPS();
}

function quitarMarcadorGPS() {
    if (capaGPS && capaGPS.parentNode) capaGPS.parentNode.removeChild(capaGPS);
    capaGPS = null;
    gpsEstado.mapa = null;
}

function puntoVisibleEnPantalla(m) {
    const sx = transX + m.x * escala, sy = transY + m.y * escala, b = 40;
    return sx > b && sx < anchoContenedor - b && sy > b && sy < altoContenedor - b;
}

function centrarEnMarcadorGPS() {
    if (!gpsEstado.mapa) return;
    const c = centroDeVista();
    const destino = Math.max(escala, limitarEscala(escalaMinimaPermitida * GPS_CONFIG.zoomAlActivar));
    animarVista(destino, gpsEstado.mapa.x, gpsEstado.mapa.y, c.x, c.y);
}

// --- Panel de diagnóstico: abrir la página con ?gpsdebug (queda activo en ese navegador; ?gpsdebug=0 lo apaga) ---
function gpsDebugActivo() {
    const q = new URLSearchParams(location.search).get('gpsdebug');
    try {
        if (q === '0') localStorage.removeItem('gpsdebug');
        else if (q !== null) localStorage.setItem('gpsdebug', '1');
        return localStorage.getItem('gpsdebug') === '1';
    } catch (_) { return q !== null && q !== '0'; }
}

// Muestra lo que reporta el teléfono y dónde cae en el mapa. «Anotar» guarda una línea; «Copiar» las copia para pegarlas en el chat.
const gpsDebug = { panel: null, lecturas: 0, mejor: Infinity, ultimo: null, lineas: [] };
const CABECERA_DEBUG = 'nota;hora;lat;lon;precision_m;x_px;y_px;x_suav;y_suav;estado';

// Muestra qué código (y qué versión del modo sin conexión) está corriendo: sirve para detectar versiones viejas guardadas en el teléfono
function mostrarVersionesApp() {
    const el = document.getElementById('version-app');
    const base = 'Código: ' + VERSION_GPS;
    if (el) el.textContent = base;
    if (!window.caches || !caches.keys) return;
    caches.keys().then(nombres => {
        const texto = base + (nombres.length ? ' · caché: ' + nombres.join(', ') : ' · sin caché');
        if (el) el.textContent = texto;
        gpsDebug.cache = nombres.length ? nombres.join(', ') : 'sin caché';
        const datos = document.getElementById('gps-debug-datos');
        if (datos && !gpsDebug.ultimo) datos.textContent = 'Código ' + VERSION_GPS + ' · caché: ' + gpsDebug.cache + '\nToca el botón de ubicación para empezar.';
    }).catch(() => {});
}

function iniciarPanelDebugGPS() {
    if (!gpsDebugActivo()) return;
    const d = document.createElement('div');
    d.id = 'gps-debug';
    d.innerHTML = '<div id="gps-debug-datos">Código ' + VERSION_GPS + '. Toca el botón de ubicación para empezar.</div>' +
        '<div class="gps-debug-botones"><button data-a="anotar">Anotar</button><button data-a="copiar">Copiar</button><button data-a="min">–</button></div>' +
        '<textarea id="gps-debug-texto" readonly hidden></textarea>';
    document.body.appendChild(d);
    gpsDebug.panel = d;
    d.addEventListener('click', (e) => {
        const a = e.target.dataset && e.target.dataset.a;
        if (a === 'anotar') anotarLecturaDebug();
        else if (a === 'copiar') copiarLecturasDebug(e.target);
        else if (a === 'min') d.classList.toggle('minimizado');
    });
}

function registrarDebugGPS(coords, p, estado, pf) {
    if (!gpsDebug.panel) return;
    gpsDebug.lecturas++;
    gpsDebug.mejor = Math.min(gpsDebug.mejor, coords.accuracy);
    const hora = new Date().toLocaleTimeString('es-VE', { hour12: false });
    pf = pf || p;
    gpsDebug.ultimo = { hora, lat: coords.latitude, lon: coords.longitude, prec: coords.accuracy, x: p.x, y: p.y, xf: pf.x, yf: pf.y, estado };
    document.getElementById('gps-debug-datos').textContent =
        `${hora}  lectura n.º ${gpsDebug.lecturas}\n` +
        `lat ${coords.latitude.toFixed(6)}\nlon ${coords.longitude.toFixed(6)}\n` +
        `precisión ±${Math.round(coords.accuracy)} m (mejor ±${Math.round(gpsDebug.mejor)} m)\n` +
        `mapa (cruda)   x ${p.x.toFixed(0)}  y ${p.y.toFixed(0)}\n` +
        `mapa (suavizada) x ${pf.x.toFixed(0)}  y ${pf.y.toFixed(0)}\n` +
        `estado: ${estado}\nanotadas: ${gpsDebug.lineas.length}`;
}

function anotarLecturaDebug() {
    const u = gpsDebug.ultimo;
    if (!u) { alert('Aún no hay ninguna lectura de GPS.'); return; }
    const nota = window.prompt('¿Dónde estás exactamente? (por ejemplo: «frente a Física»)', '');
    if (nota === null) return; // cancelado
    gpsDebug.lineas.push([nota.replace(/;/g, ','), u.hora, u.lat.toFixed(6), u.lon.toFixed(6), Math.round(u.prec), u.x.toFixed(0), u.y.toFixed(0), u.xf.toFixed(0), u.yf.toFixed(0), u.estado].join(';'));
    document.getElementById('gps-debug-datos').textContent += `\n(anotada ✓ ${gpsDebug.lineas.length})`;
}

function copiarLecturasDebug(boton) {
    const texto = [CABECERA_DEBUG, ...gpsDebug.lineas].join('\n');
    const area = document.getElementById('gps-debug-texto');
    const mostrarTexto = () => { area.value = texto; area.hidden = false; area.focus(); area.select(); }; // plan B: copiar a mano
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(() => {
            boton.textContent = 'Copiado ✓';
            setTimeout(() => { boton.textContent = 'Copiar'; }, 1500);
        }).catch(mostrarTexto);
    } else mostrarTexto();
}

function alPosicionGPS(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    const p = gpsAPx(longitude, latitude), z = gpsModelo.zona;
    if (accuracy > GPS_CONFIG.precisionMaxima) {
        registrarDebugGPS(pos.coords, p, 'señal débil (ignorada)');
        if (!gpsEstado.avisoDebil) { gpsEstado.avisoDebil = true; mostrarAviso(`Señal GPS débil (±${Math.round(accuracy)} m). Sal a un lugar despejado.`); }
        return;
    }
    gpsEstado.avisoDebil = false;
    if (p.x < z.x0 || p.x > z.x1 || p.y < z.y0 || p.y > z.y1) {
        quitarMarcadorGPS();
        registrarDebugGPS(pos.coords, p, 'fuera de la zona del mapa');
        if (!gpsEstado.avisoFuera) { gpsEstado.avisoFuera = true; mostrarAviso('Tu ubicación está fuera de la zona del mapa.'); }
        return;
    }
    gpsEstado.avisoFuera = false;
    const f = filtrarPosicionGPS(latitude, longitude, accuracy, pos.timestamp || Date.now());
    const pf = gpsAPx(f.lon, f.lat); // posición suavizada: la que se dibuja
    gpsEstado.mapa = { x: pf.x - desfaseX, y: pf.y - desfaseY }; // coordenadas del mapa (lo que usa animarVista)
    dibujarMarcadorGPS(pf, accuracy);
    registrarDebugGPS(pos.coords, p, 'ok', pf);
    if (!gpsEstado.centrado) { gpsEstado.centrado = true; cerrarAviso(); centrarEnMarcadorGPS(); }
}

function alErrorGPS(err) {
    if (err.code === 1) { // permiso denegado
        desactivarGPS();
        mostrarAviso('No hay permiso para usar la ubicación. Actívalo en los ajustes del navegador.', { tipo: 'error' });
    } else if (err.code === 2) {
        mostrarAviso('No se pudo obtener la ubicación. Comprueba que el GPS esté encendido.');
    } else if (!gpsEstado.avisoDebil) { // 3: tiempo agotado; el GPS sigue intentando
        gpsEstado.avisoDebil = true;
        mostrarAviso('Buscando señal GPS… sal a un lugar despejado.');
    }
}

function iniciarVigilanciaGPS() {
    const prueba = new URLSearchParams(location.search).get('gpsprueba'); // ?gpsprueba=lat,lon[,precisión]: ubicación falsa para probar
    if (prueba) {
        const [lat, lon, prec] = prueba.split(',').map(Number);
        setTimeout(() => alPosicionGPS({ coords: { latitude: lat, longitude: lon, accuracy: prec || 10 } }), 300);
        return;
    }
    gpsEstado.watchId = navigator.geolocation.watchPosition(alPosicionGPS, alErrorGPS,
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

function detenerVigilanciaGPS() {
    if (gpsEstado.watchId !== null) { navigator.geolocation.clearWatch(gpsEstado.watchId); gpsEstado.watchId = null; }
}

function marcarBotonUbicacion(activo) {
    const b = document.getElementById('btn-vista-inicial');
    if (!b) return;
    b.classList.toggle('activo', activo);
    b.setAttribute('aria-pressed', String(activo));
}

function activarGPS() {
    if (!prepararModeloGPS()) { mostrarAviso('No se pudo preparar la calibración del GPS.', { tipo: 'error' }); return; }
    reiniciarFiltroGPS();
    gpsEstado.activo = true; gpsEstado.pausado = false; gpsEstado.centrado = false;
    gpsEstado.avisoFuera = false; gpsEstado.avisoDebil = false;
    marcarBotonUbicacion(true);
    mostrarAviso('Buscando tu ubicación…');
    iniciarVigilanciaGPS();
}

function desactivarGPS() {
    detenerVigilanciaGPS();
    quitarMarcadorGPS();
    gpsEstado.activo = false; gpsEstado.pausado = false;
    marcarBotonUbicacion(false);
}

// Primer toque: activa y centra. Con el GPS activo: si el punto no se ve, lo vuelve a centrar; si se ve, apaga el GPS.
function alPulsarUbicacion() {
    if (!mapaInicializado) return;
    if (!gpsEstado.activo) { activarGPS(); return; }
    if (gpsEstado.mapa && !puntoVisibleEnPantalla(gpsEstado.mapa)) { centrarEnMarcadorGPS(); return; }
    desactivarGPS();
}

// ¿Se ofrece la ubicación? Solo en teléfono/tableta con GPS (o con ?gpsprueba para probar en computadora)
function gpsDisponible() {
    if (new URLSearchParams(location.search).has('gpsprueba') || gpsDebugActivo()) return true; // para probar también en computadora
    return !!navigator.geolocation && (!GPS_CONFIG.soloMovil || esDispositivoMovil());
}

function inicializarUbicacionGPS() {
    const boton = document.getElementById('btn-vista-inicial');
    iniciarPanelDebugGPS();
    mostrarVersionesApp();
    if (!boton || !gpsDisponible()) return;
    boton.title = 'Mi ubicación';
    boton.setAttribute('aria-label', 'Mi ubicación');
    boton.setAttribute('aria-pressed', 'false');
    boton.addEventListener('click', alPulsarUbicacion);
    // Para ahorrar batería, el GPS se pausa cuando la app queda en segundo plano
    document.addEventListener('visibilitychange', () => {
        if (!gpsEstado.activo) return;
        if (document.visibilityState === 'hidden') { detenerVigilanciaGPS(); gpsEstado.pausado = true; }
        else if (gpsEstado.pausado) { gpsEstado.pausado = false; iniciarVigilanciaGPS(); }
    });
}

// --- 5.6 AVISOS (mensajes breves abajo) Y PANTALLA DE CARGA ---
let temporizadorAviso = null;

function cerrarAviso() {
    clearTimeout(temporizadorAviso);
    const cont = document.getElementById('avisos');
    if (cont) cont.textContent = '';
}

// Un solo aviso a la vez. tipo: 'info' | 'error'. Los de error se quedan hasta que el usuario los cierra o reintenta.
function mostrarAviso(texto, { tipo = 'info', accion = null, alAccion = null, persistente = false } = {}) {
    const cont = document.getElementById('avisos');
    if (!cont) return;
    cerrarAviso();
    const aviso = document.createElement('div');
    aviso.className = `aviso aviso-${tipo}`;
    const t = document.createElement('span');
    t.className = 'aviso-texto';
    t.textContent = texto;
    aviso.appendChild(t);
    if (accion) {
        const b = document.createElement('button');
        b.className = 'aviso-accion';
        b.textContent = accion;
        b.addEventListener('click', () => { if (alAccion) alAccion(); });
        aviso.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'aviso-cerrar';
    x.setAttribute('aria-label', 'Cerrar aviso');
    x.textContent = '×';
    x.addEventListener('click', cerrarAviso);
    aviso.appendChild(x);
    cont.appendChild(aviso);
    if (!persistente && tipo !== 'error') temporizadorAviso = setTimeout(cerrarAviso, 6000);
}

let cargaInicialTerminada = false;

function mostrarCarga() {
    const p = document.getElementById('pantalla-carga');
    if (!p) return;
    p.hidden = false;
    p.classList.remove('error', 'oculta');
    document.getElementById('carga-titulo').textContent = 'Cargando el mapa…';
    document.getElementById('carga-detalle').textContent = '';
    document.getElementById('btn-reintentar-mapa').hidden = true;
}

function ocultarCarga() {
    const p = document.getElementById('pantalla-carga');
    if (!p || p.hidden) return;
    p.classList.add('oculta');
    setTimeout(() => { p.hidden = true; }, 350);
}

function mostrarErrorCarga(error) {
    const p = document.getElementById('pantalla-carga');
    p.hidden = false;
    p.classList.remove('oculta');
    p.classList.add('error');
    document.getElementById('carga-titulo').textContent = 'No se pudo cargar el mapa';
    document.getElementById('carga-detalle').textContent = `${error.message} Revisa tu conexión e inténtalo de nuevo.`;
    document.getElementById('btn-reintentar-mapa').hidden = false;
}

function avisarHorariosNoDisponibles() {
    mostrarAviso('Los horarios no están disponibles, así que no se pueden buscar salones, profesores ni materias.',
        { tipo: 'error', accion: 'Reintentar', alAccion: reintentarDatos });
}

// Avisa de los archivos de datos que fallaron; el mapa sigue funcionando sin ellos
function avisarDatosFaltantes(errHorarios, errEstructuras) {
    if (!errHorarios && !errEstructuras) return;
    const partes = [];
    if (errHorarios) partes.push('los horarios (la búsqueda de salones, profesores y materias no funcionará)');
    if (errEstructuras) partes.push('la lista de lugares (cantinas, baños, escuelas…)');
    const detalle = (errHorarios || errEstructuras).message;
    mostrarAviso(`No se pudieron cargar ${partes.join(' ni ')}. ${detalle}`,
        { tipo: 'error', accion: 'Reintentar', alAccion: reintentarDatos });
}

let intentoCarga = 0;

async function iniciarCarga({ silencioso = false } = {}) {
    const miIntento = ++intentoCarga;
    if (!silencioso) mostrarCarga();
    const aviso = setTimeout(() => {
        const d = document.getElementById('carga-detalle');
        if (miIntento === intentoCarga && d && !silencioso) d.textContent = 'Sigue cargando… la conexión parece lenta.';
    }, 7000);

    const [errSvg, errHorarios, errEstructuras] = await Promise.all([
        mapaCargado ? null : cargarSVGMapa(),
        horariosListos ? null : cargarHorarios(),
        estructurasListas ? null : cargarEstructuras()
    ]);
    clearTimeout(aviso);
    if (miIntento !== intentoCarga) return;

    if (errSvg) { mostrarErrorCarga(errSvg); return; }

    procesarEstructuras();
    procesarSugerencias();
    construirOpcionesBusqueda();
    ocupacionPorSalon = null;
    if (!mapaInicializado && !svgEl) {
        inicializarPanZoom();
        setTimeout(ocultarCarga, 4000); // por si el primer dibujo no llega a producirse
    }
    cerrarAviso();
    if (datosDesdeCache && !errHorarios && !errEstructuras) {
        const fecha = new Date(datosDesdeCache).toLocaleString('es-VE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        mostrarAviso(navigator.onLine
            ? `La conexión es lenta: se usan los datos guardados (${fecha}).`
            : `Sin conexión: se usan los datos guardados (${fecha}).`, { persistente: true });
    }
    avisarDatosFaltantes(errHorarios, errEstructuras);
}

async function reintentarDatos() {
    mostrarAviso('Reintentando…', { persistente: true });
    await iniciarCarga({ silencioso: true });
    if (horariosListos && estructurasListas) mostrarAviso('Datos cargados correctamente.');
}

// --- 9. APP INSTALABLE Y MODO SIN CONEXIÓN ---
const PWA_CONFIG = {
    // false: en localhost el modo sin conexión NO se activa, para que siempre veas tus cambios mientras editas.
    //        Para probarlo en local abre la página con  ?sw=1  (por ejemplo http://127.0.0.1:5500/index.html?sw=1)
    registrarEnLocal: false
};

function esEntornoLocal() {
    return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

// Teléfono o tableta (pantalla táctil sin ratón). En computadora no se ofrece instalar desde la página.
function esDispositivoMovil() {
    const tactil = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    return tactil || /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function esAppInstalada() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function iniciarPWA() {
    if (!('serviceWorker' in navigator)) return;
    const forzar = new URLSearchParams(location.search).has('sw');

    if (esEntornoLocal() && !PWA_CONFIG.registrarEnLocal && !forzar) {
        // Desarrollo: se limpia cualquier copia guardada para no ver archivos viejos mientras editas
        (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
        if (window.caches) (await caches.keys()).filter(k => k.startsWith('geofacing-')).forEach(k => caches.delete(k));
        return;
    }

    const teniaControlador = !!navigator.serviceWorker.controller;
    try {
        const registro = await navigator.serviceWorker.register('./sw.js', { scope: './' });

        // Versión nueva lista: se ofrece actualizar (no se recarga sola para no interrumpir lo que haces)
        const avisarSiHayNueva = () => {
            if (registro.waiting && navigator.serviceWorker.controller) {
                mostrarAviso('Hay una nueva versión de GeoFacing.',
                    { accion: 'Actualizar', alAccion: () => registro.waiting.postMessage('saltar-espera'), persistente: true });
            }
        };
        avisarSiHayNueva();
        registro.addEventListener('updatefound', () => {
            const nuevo = registro.installing;
            if (nuevo) nuevo.addEventListener('statechange', () => { if (nuevo.state === 'installed') avisarSiHayNueva(); });
        });

        let recargando = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!teniaControlador || recargando) return; // la primera instalación no necesita recargar
            recargando = true;
            location.reload();
        });

        // al volver a la app, comprueba si hay una versión nueva
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') registro.update().catch(() => {});
        });

        // pide al navegador que no borre lo guardado cuando falte espacio
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (error) {
        console.warn('⚠️ No se pudo activar el modo sin conexión:', error);
    }
}

function inicializarAvisosDeConexion() {
    window.addEventListener('offline', () => {
        if (mapaInicializado) mostrarAviso('Sin conexión. El mapa y los horarios ya cargados siguen disponibles.');
    });
    window.addEventListener('online', () => {
        if (!mapaInicializado) return;
        if (datosDesdeCache) mostrarAviso('Conexión restablecida.', { accion: 'Actualizar datos', alAccion: () => location.reload(), persistente: true });
        else mostrarAviso('Conexión restablecida.');
    });
}

// Botón "Instalar" del menú (Chrome, Edge y Samsung Internet) o instrucciones para iPhone/iPad
let promptInstalacion = null;

function actualizarSeccionInstalar() {
    const seccion = document.getElementById('seccion-instalar');
    const separador = document.getElementById('sep-instalar');
    const boton = document.getElementById('btn-instalar');
    const texto = document.getElementById('texto-instalar');
    if (!seccion) return;
    let mostrar = false;
    if (!esAppInstalada() && esDispositivoMovil()) {
        if (promptInstalacion) {
            mostrar = true;
            boton.hidden = false;
            texto.textContent = 'Añade GeoFacing a tu pantalla de inicio: se abre como una app y también funciona sin conexión.';
        } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
            mostrar = true;
            boton.hidden = true;
            texto.textContent = 'En iPhone o iPad: pulsa el botón Compartir y elige «Añadir a pantalla de inicio». Así se abre como una app y funciona sin conexión.';
        }
    }
    seccion.hidden = !mostrar;
    separador.hidden = !mostrar;
}

function inicializarInstalacion() {
    window.addEventListener('beforeinstallprompt', evento => {
        evento.preventDefault(); // se usa el botón del menú en vez del aviso automático
        promptInstalacion = evento;
        actualizarSeccionInstalar();
    });
    window.addEventListener('appinstalled', () => {
        promptInstalacion = null;
        actualizarSeccionInstalar();
        mostrarAviso('GeoFacing se instaló en tu pantalla de inicio.');
    });
    const boton = document.getElementById('btn-instalar');
    if (boton) boton.addEventListener('click', async () => {
        if (!promptInstalacion) return;
        const peticion = promptInstalacion;
        promptInstalacion = null;
        cerrarMenuDrawer();
        peticion.prompt();
        await peticion.userChoice;
        actualizarSeccionInstalar();
    });
    actualizarSeccionInstalar();
}

// --- 8. INICIALIZACIÓN GENERAL ---
document.addEventListener('DOMContentLoaded', () => {
    inicializarBuscador();
    inicializarHojaMovil();
    inicializarMenuOpciones();
    inicializarControlesMapa();
    inicializarUbicacionGPS();
    inicializarInstalacion();
    inicializarAvisosDeConexion();
    window.addEventListener('load', iniciarPWA);
    const btnReintentar = document.getElementById('btn-reintentar-mapa');
    if (btnReintentar) btnReintentar.addEventListener('click', () => iniciarCarga());
    // si vuelve la conexión mientras se muestra el error del mapa, reintenta solo
    window.addEventListener('online', () => {
        const p = document.getElementById('pantalla-carga');
        if (p && !p.hidden && p.classList.contains('error')) iniciarCarga();
    });
    iniciarCarga();
});