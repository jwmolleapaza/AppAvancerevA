/* ==========================================================================
   CONSTRUTECH - CORE LOGIC & AIRTABLE INTEGRATION (app.js)
   ========================================================================== */

// --- CONFIGURACIÓN DE AIRTABLE (CARGADA DINÁMICAMENTE) ---
let AIRTABLE_PAT = '';
let BASE_ID = '';
let API_URL = '';

// --- ESTADOS Y CACHÉ GENERAL ---
let masterTurnos = [];
let masterSupervisores = [];
let masterProyectos = [];
let masterPersonal = [];
let masterUsuarios = [];

let currentUser = null;

// Reporte en construcción
let activeReportActivities = []; // Actividades agregadas: [{ id, proyecto, frente, disciplina, area, activityId, actividad, unidad, metrado, personal: [{ dni, nombre, categoria, hh }] }]
let attachedPhotos = [];        // Fotos cargadas: [{ dataUrl, activityId, filename, file }]

// Caché de historial cargado de Airtable
let historicalReports = [];
let historicalActivities = [];
let historicalPersonal = [];
let historicalEvidencias = [];

// --- CARGAR CONFIGURACIÓN ---
async function loadConfiguration() {
    try {
        const response = await fetch('config.json');
        if (response.ok) {
            const config = await response.json();
            AIRTABLE_PAT = config.AIRTABLE_PAT || '';
            BASE_ID = config.BASE_ID || '';
            console.log('Configuración cargada desde config.json.');
        }
    } catch (err) {
        console.log('config.json no disponible, buscando en localStorage...');
    }

    if (!AIRTABLE_PAT) {
        AIRTABLE_PAT = localStorage.getItem('construtech_airtable_pat') || '';
    }
    if (!BASE_ID) {
        BASE_ID = localStorage.getItem('construtech_base_id') || '';
    }

    const patInput = document.getElementById('setup-airtable-pat');
    const baseInput = document.getElementById('setup-base-id');
    if (patInput) patInput.value = AIRTABLE_PAT;
    if (baseInput) baseInput.value = BASE_ID;

    updateApiUrl();
}

function updateApiUrl() {
    API_URL = BASE_ID ? `https://api.airtable.com/v0/${BASE_ID}` : '';
}

// --- INICIALIZADOR ---
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    setupUIEventHandlers();
    startClock();
    
    // Cargar credenciales dinámicas
    await loadConfiguration();
    
    // Validar Sesión Activa
    const cachedSession = localStorage.getItem('construtech_session');
    if (cachedSession) {
        currentUser = JSON.parse(cachedSession);
        showAppLayout();
        showSpinner('Cargando base de datos...');
        await loadMasterCatalogs();
        hideSpinner();
        initializeReportForm();
        loadHistoricalLog();
    } else {
        showLoginScreen();
    }
}

// --- RELOJ DEL SISTEMA ---
function startClock() {
    const updateTime = () => {
        const now = new Date();
        const dateEl = document.getElementById('report-system-date');
        const timeEl = document.getElementById('report-system-time');
        
        if (dateEl) dateEl.value = now.toLocaleDateString('es-PE');
        if (timeEl) timeEl.value = now.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    updateTime();
    setInterval(updateTime, 1000);
}

// --- GESTIÓN DE PANTALLAS (LOGIN / APP) ---
function showLoginScreen() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-container').classList.add('hidden');
    hideSpinner();
}

function showAppLayout() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    
    if (currentUser) {
        document.getElementById('user-display-name').innerText = currentUser.Usuario.toUpperCase();
        document.getElementById('user-display-role').innerText = 'Supervisor Autorizado';
    }
}

// --- CARGA DE CATÁLOGOS MAESTROS (AIRTABLE) ---
async function loadMasterCatalogs() {
    try {
        console.log('Descargando catálogos de Airtable...');
        
        // Carga paralela de catálogos principales
        const [usersData, shiftsData, supervisorsData, projectsData, personalData] = await Promise.all([
            fetchAirtableRecords('Login'),
            fetchAirtableRecords('Turno'),
            fetchAirtableRecords('Supervisor'),
            fetchAirtableRecords('Proyecto'),
            fetchAirtableRecords('Personal')
        ]);
        
        masterUsuarios = usersData.map(r => r.fields);
        masterTurnos = shiftsData.map(r => r.fields.Turno).filter(Boolean);
        
        masterSupervisores = supervisorsData.map(r => ({
            dni: r.fields.DNI,
            nombre: r.fields['APELLIDO Y NOMBRE'],
            categoria: r.fields.CATEGORIA
        })).filter(s => s.nombre);

        masterProyectos = projectsData.map(r => ({
            id: r.id,
            proyecto: r.fields.Proyecto,
            frente: r.fields.Frente,
            disciplina: r.fields.Disciplina,
            area: r.fields.Area,
            activityId: r.fields['Activitiy ID'] || r.fields['Activity ID'], // Soportar ambos
            actividad: r.fields.Actividad,
            unidad: r.fields.Unidad
        })).filter(p => p.activityId);

        masterPersonal = personalData.map(r => ({
            dni: r.fields.DNI,
            nombre: r.fields['APELLIDO Y NOMBRE'],
            categoria: r.fields.CATEGORIA,
            area: r.fields.AREA
        })).filter(p => p.dni && p.nombre);

        console.log('Catálogos cargados con éxito.');
        updateConnectionStatus(true);
    } catch (err) {
        console.error('Error al cargar catálogos maestros de Airtable:', err);
        showToast('Error de red al sincronizar catálogos.', 'danger');
        updateConnectionStatus(false);
    }
}

// --- FUNCIÓN GENÉRICA PARA LEER DE AIRTABLE ---
async function fetchAirtableRecords(tableName) {
    let allRecords = [];
    let offset = '';
    
    do {
        const url = `${API_URL}/${encodeURIComponent(tableName)}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_PAT}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`Error HTTP: ${response.status} al leer tabla ${tableName}`);
        }
        
        const data = await response.json();
        allRecords = allRecords.concat(data.records);
        offset = data.offset || '';
    } while (offset);
    
    return allRecords;
}

// --- CONEXIÓN DIRECTA POST A AIRTABLE ---
async function createAirtableRecords(tableName, recordsArray) {
    // Airtable limita la creación a lotes de máximo 10 registros por llamada
    const batchSize = 10;
    const results = [];
    
    for (let i = 0; i < recordsArray.length; i += batchSize) {
        const batch = recordsArray.slice(i, i + batchSize);
        const payload = {
            records: batch.map(fields => ({ fields }))
        };
        
        const response = await fetch(`${API_URL}/${encodeURIComponent(tableName)}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_PAT}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Error al guardar en ${tableName}: ${response.status} - ${errText}`);
        }
        
        const data = await response.json();
        results.push(...data.records);
    }
    
    return results;
}

// --- CONFIGURACIÓN DE ELEMENTOS UI ---
function setupUIEventHandlers() {
    // 1. Manejador de Login
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    
    // Toggle de configuración de Airtable en Login
    const btnToggleSetup = document.getElementById('btn-toggle-setup');
    if (btnToggleSetup) {
        btnToggleSetup.addEventListener('click', () => {
            const container = document.getElementById('setup-fields-container');
            if (container) {
                container.classList.toggle('hidden');
            }
        });
    }
    
    // 2. Botón Logout
    document.getElementById('btn-logout').addEventListener('click', handleLogout);
    
    // 3. Pestañas de Navegación (Tabs)
    const tabs = document.querySelectorAll('.tab-nav-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            const targetId = tab.id;
            switchTab(targetId);
        });
    });
    
    // 4. Planificación: Filtros en Cascada
    document.getElementById('select-proyecto').addEventListener('change', (e) => {
        onProyectoChange(e.target.value);
    });
    document.getElementById('select-frente').addEventListener('change', (e) => {
        onFrenteChange(e.target.value);
    });
    document.getElementById('select-disciplina').addEventListener('change', (e) => {
        onDisciplinaChange(e.target.value);
    });
    document.getElementById('select-area').addEventListener('change', (e) => {
        onAreaChange(e.target.value);
    });
    document.getElementById('select-activity-id').addEventListener('change', (e) => {
        onActivityIdChange(e.target.value);
    });

    // 5. Agregar Actividad al Grid
    document.getElementById('btn-add-activity-grid').addEventListener('click', addActivityToGrid);
    
    // 6. Manejo de Evidencias Fotográficas
    document.getElementById('input-camera-gallery').addEventListener('change', handlePhotoSelection);
    
    // 7. Guardado General a Airtable
    document.getElementById('btn-submit-report-airtable').addEventListener('click', submitReportToAirtable);
    
    // 8. Consulta Histórica: Filtros
    document.getElementById('btn-apply-history-filters').addEventListener('click', applyHistoricalFilters);
    document.getElementById('btn-clear-history-filters').addEventListener('click', clearHistoricalFilters);
    document.getElementById('btn-export-history-excel').addEventListener('click', exportHistoryToExcel);
    document.getElementById('btn-export-history-pdf').addEventListener('click', () => window.print());
    
    // 9. Modal controles
    document.getElementById('btn-close-modal').addEventListener('click', hideModal);
    document.getElementById('btn-modal-close-footer').addEventListener('click', hideModal);
    document.getElementById('btn-modal-print').addEventListener('click', () => window.print());
}

// --- LÓGICA DE NAVEGACIÓN (TABS) ---
function switchTab(tabId) {
    // Activar botón del tab
    const tabs = document.querySelectorAll('.tab-nav-btn');
    tabs.forEach(t => t.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    
    // Mostrar panel correspondiente
    const panels = document.querySelectorAll('.tab-content-panel');
    panels.forEach(p => p.classList.remove('active'));
    
    if (tabId === 'tab-new-report') {
        document.getElementById('section-new-report').classList.add('active');
    } else if (tabId === 'tab-history-reports') {
        document.getElementById('section-history').classList.add('active');
        loadHistoricalLog(); // Recargar log
    } else if (tabId === 'tab-dashboard-view') {
        document.getElementById('section-dashboard').classList.add('active');
        if (window.renderDashboardCharts) {
            window.renderDashboardCharts(); // Dibujar gráficos
        }
    }
}

// --- EVENTO LOGIN ---
async function handleLogin(e) {
    e.preventDefault();
    
    // Guardar tokens si se especificaron
    const patInput = document.getElementById('setup-airtable-pat');
    const baseInput = document.getElementById('setup-base-id');
    if (patInput && baseInput) {
        const patVal = patInput.value.trim();
        const baseVal = baseInput.value.trim();
        if (patVal) {
            AIRTABLE_PAT = patVal;
            localStorage.setItem('construtech_airtable_pat', patVal);
        }
        if (baseVal) {
            BASE_ID = baseVal;
            localStorage.setItem('construtech_base_id', baseVal);
        }
        updateApiUrl();
    }
    
    if (!AIRTABLE_PAT || !BASE_ID) {
        showToast('Debe configurar el Token de Airtable (PAT) y el Base ID para conectar.', 'danger');
        document.getElementById('setup-fields-container').classList.remove('hidden');
        return;
    }
    
    const usernameInput = document.getElementById('login-username').value.trim();
    const passwordInput = document.getElementById('login-password').value.trim();
    
    showSpinner('Autenticando usuario...');
    
    try {
        // Si no se han cargado los catálogos (primer login offline, etc.)
        if (masterUsuarios.length === 0) {
            await loadMasterCatalogs();
        }
        
        // Buscar coincidencia en Login
        const matchedUser = masterUsuarios.find(u => 
            u.Usuario === usernameInput && 
            (u.Contrasea === passwordInput || u['Contraseña'] === passwordInput)
        );
        
        if (matchedUser) {
            currentUser = {
                Usuario: usernameInput,
                Estado: matchedUser.Estado || 'Activo'
            };
            localStorage.setItem('construtech_session', JSON.stringify(currentUser));
            document.getElementById('login-error-msg').classList.add('hidden');
            showAppLayout();
            initializeReportForm();
            loadHistoricalLog();
            showToast('Acceso autorizado.', 'success');
        } else {
            document.getElementById('login-error-msg').classList.remove('hidden');
            showToast('Usuario o contraseña no válidos.', 'danger');
        }
    } catch (err) {
        console.error('Error durante autenticación:', err);
        showToast('Error al conectar con la base de datos.', 'danger');
    } finally {
        hideSpinner();
    }
}

// --- EVENTO LOGOUT ---
function handleLogout() {
    if (confirm('¿Desea cerrar la sesión actual del supervisor?')) {
        localStorage.removeItem('construtech_session');
        currentUser = null;
        activeReportActivities = [];
        attachedPhotos = [];
        
        // Limpiar inputs
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-error-msg').classList.add('hidden');
        
        showLoginScreen();
    }
}

// --- INICIALIZAR EL FORMULARIO DE REPORTE DIARIO ---
function initializeReportForm() {
    // 1. Cargar Turnos
    const shiftSelect = document.getElementById('report-select-turno');
    shiftSelect.innerHTML = '<option value="" disabled selected>Seleccione Turno...</option>';
    masterTurnos.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.innerText = t.toUpperCase();
        shiftSelect.appendChild(opt);
    });
    
    // 2. Cargar Supervisores
    const supervisorSelect = document.getElementById('report-select-supervisor');
    supervisorSelect.innerHTML = '<option value="" disabled selected>Seleccione Supervisor...</option>';
    masterSupervisores.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.nombre;
        opt.innerText = s.nombre;
        supervisorSelect.appendChild(opt);
    });

    // 3. Cargar Proyectos (Primer nivel de cascada)
    const proyectoSelect = document.getElementById('select-proyecto');
    proyectoSelect.innerHTML = '<option value="" disabled selected>Seleccione Proyecto...</option>';
    
    const uniqueProjs = [...new Set(masterProyectos.map(p => p.proyecto))].filter(Boolean);
    uniqueProjs.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.innerText = p;
        proyectoSelect.appendChild(opt);
    });

    // Inhabilitar posteriores
    resetCascadingSelectsFrom('frente');
    
    // 4. Inicializar filtros de áreas de personal
    renderPersonnelAreaFilters();
    
    // 5. Resetear grilla y evidencias
    activeReportActivities = [];
    attachedPhotos = [];
    renderActivitiesGrid();
    renderPhotosGallery();
    updateGeneralReportTotals();
}

// --- CASCADA DE FILTROS DEPENDIENTES ---
function resetCascadingSelectsFrom(level) {
    const levels = ['frente', 'disciplina', 'area', 'activity-id'];
    const startIndex = levels.indexOf(level);
    
    for (let i = startIndex; i < levels.length; i++) {
        const select = document.getElementById(`select-${levels[i]}`);
        select.innerHTML = `<option value="" disabled selected>Seleccione ${levels[i].replace('-', ' ').toUpperCase()}...</option>`;
        select.disabled = true;
    }
    
    // Limpiar campos informativos
    document.getElementById('display-actividad-nombre').value = '';
    document.getElementById('display-actividad-unidad').value = '';
    document.getElementById('display-metrado-unidad').innerText = '-';
}

function onProyectoChange(proyecto) {
    resetCascadingSelectsFrom('frente');
    const frentes = [...new Set(masterProyectos.filter(p => p.proyecto === proyecto).map(p => p.frente))].filter(Boolean);
    
    const select = document.getElementById('select-frente');
    select.disabled = false;
    select.innerHTML = '<option value="" disabled selected>Seleccione Frente...</option>';
    frentes.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.innerText = f;
        select.appendChild(opt);
    });
}

function onFrenteChange(frente) {
    resetCascadingSelectsFrom('disciplina');
    const proyecto = document.getElementById('select-proyecto').value;
    const disciplinas = [...new Set(masterProyectos.filter(p => p.proyecto === proyecto && p.frente === frente).map(p => p.disciplina))].filter(Boolean);
    
    const select = document.getElementById('select-disciplina');
    select.disabled = false;
    select.innerHTML = '<option value="" disabled selected>Seleccione Disciplina...</option>';
    disciplinas.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.innerText = d;
        select.appendChild(opt);
    });
}

function onDisciplinaChange(disciplina) {
    resetCascadingSelectsFrom('area');
    const proyecto = document.getElementById('select-proyecto').value;
    const frente = document.getElementById('select-frente').value;
    const areas = [...new Set(masterProyectos.filter(p => p.proyecto === proyecto && p.frente === frente && p.disciplina === disciplina).map(p => p.area))].filter(Boolean);
    
    const select = document.getElementById('select-area');
    select.disabled = false;
    select.innerHTML = '<option value="" disabled selected>Seleccione Área...</option>';
    areas.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a;
        opt.innerText = a;
        select.appendChild(opt);
    });
}

function onAreaChange(area) {
    resetCascadingSelectsFrom('activity-id');
    const proyecto = document.getElementById('select-proyecto').value;
    const frente = document.getElementById('select-frente').value;
    const disciplina = document.getElementById('select-disciplina').value;
    const activities = masterProyectos.filter(p => p.proyecto === proyecto && p.frente === frente && p.disciplina === disciplina && p.area === area);
    
    const select = document.getElementById('select-activity-id');
    select.disabled = false;
    select.innerHTML = '<option value="" disabled selected>Seleccione Activity ID...</option>';
    activities.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.activityId;
        opt.innerText = a.activityId;
        select.appendChild(opt);
    });
}

function onActivityIdChange(activityId) {
    const proyecto = document.getElementById('select-proyecto').value;
    const frente = document.getElementById('select-frente').value;
    const disciplina = document.getElementById('select-disciplina').value;
    const area = document.getElementById('select-area').value;
    
    const found = masterProyectos.find(p => 
        p.proyecto === proyecto && 
        p.frente === frente && 
        p.disciplina === disciplina && 
        p.area === area && 
        p.activityId === activityId
    );
    
    if (found) {
        document.getElementById('display-actividad-nombre').value = found.actividad;
        document.getElementById('display-actividad-unidad').value = found.unidad;
        document.getElementById('display-metrado-unidad').innerText = found.unidad;
    }
}

// --- FILTRO DE PERSONAL POR ÁREA ---
function renderPersonnelAreaFilters() {
    const buttonGrid = document.getElementById('personnel-area-buttons');
    buttonGrid.innerHTML = '';
    
    // Obtener áreas únicas del personal
    const uniqueAreas = [...new Set(masterPersonal.map(p => p.area))].filter(Boolean).sort();
    
    // Botón "TODOS" por defecto
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'area-btn active';
    allBtn.innerText = 'TODOS';
    allBtn.addEventListener('click', () => {
        document.querySelectorAll('.area-btn').forEach(b => b.classList.remove('active'));
        allBtn.classList.add('active');
        filterPersonnelListByArea('ALL');
    });
    buttonGrid.appendChild(allBtn);
    
    uniqueAreas.forEach(area => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'area-btn';
        btn.innerText = area.toUpperCase();
        btn.addEventListener('click', () => {
            document.querySelectorAll('.area-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterPersonnelListByArea(area);
        });
        buttonGrid.appendChild(btn);
    });
    
    // Renderizar la lista de personal completa al inicio
    renderPersonnelChecklist(masterPersonal);
}

function renderPersonnelChecklist(personnelList) {
    const scrollList = document.getElementById('personnel-checkbox-list');
    scrollList.innerHTML = '';
    
    if (personnelList.length === 0) {
        scrollList.innerHTML = '<div class="no-data-indicator">No hay personal para esta área.</div>';
        return;
    }
    
    personnelList.forEach(worker => {
        const card = document.createElement('div');
        card.className = 'personnel-checkbox-card';
        card.id = `worker-card-${worker.dni}`;
        
        card.innerHTML = `
            <input type="checkbox" id="chk-worker-${worker.dni}" value="${worker.dni}">
            <div class="worker-details-label">
                <span class="worker-label-name">${worker.nombre}</span>
                <span class="worker-label-cat">${worker.area.toUpperCase()} | ${worker.categoria}</span>
            </div>
        `;
        
        const checkbox = card.querySelector('input');
        
        // Sincronizar clic en tarjeta con el checkbox
        card.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
            }
            if (checkbox.checked) {
                card.classList.add('checked');
                addWorkerToHHList(worker);
            } else {
                card.classList.remove('checked');
                removeWorkerFromHHList(worker.dni);
            }
            recalculateCurrentActivityHH();
        });
        
        scrollList.appendChild(card);
    });
}

function filterPersonnelListByArea(area) {
    if (area === 'ALL') {
        renderPersonnelChecklist(masterPersonal);
    } else {
        const filtered = masterPersonal.filter(p => p.area === area);
        renderPersonnelChecklist(filtered);
    }
    
    // Remarcar los checkboxes que ya estaban seleccionados
    const currentActivityCheckedDnis = getSelectedWorkersInAllocationList();
    currentActivityCheckedDnis.forEach(dni => {
        const chk = document.getElementById(`chk-worker-${dni}`);
        if (chk) {
            chk.checked = true;
            document.getElementById(`worker-card-${dni}`).classList.add('checked');
        }
    });
}

function getSelectedWorkersInAllocationList() {
    const rows = document.querySelectorAll('.hh-allocation-row');
    return Array.from(rows).map(row => row.dataset.dni);
}

// --- ENTRADAS DE HORAS HOMBRE (HH) RE-ACTIVAS ---
function addWorkerToHHList(worker) {
    const hhList = document.getElementById('personnel-hh-inputs');
    
    // Limpiar indicador de "no hay datos"
    const indicator = hhList.querySelector('.no-data-indicator');
    if (indicator) indicator.remove();
    
    // Si ya existe en el DOM, no duplicar
    if (document.getElementById(`hh-row-${worker.dni}`)) return;
    
    const row = document.createElement('div');
    row.className = 'hh-allocation-row';
    row.id = `hh-row-${worker.dni}`;
    row.dataset.dni = worker.dni;
    row.dataset.name = worker.nombre;
    row.dataset.category = worker.categoria;
    
    row.innerHTML = `
        <div class="hh-row-worker-info">
            <span class="hh-worker-name-lbl">${worker.nombre}</span>
            <span class="hh-worker-sub-lbl">${worker.area.toUpperCase()} | ${worker.categoria}</span>
        </div>
        <div class="hh-adjuster-box">
            <button type="button" class="hh-btn-adjust hh-dec">-</button>
            <input type="number" class="hh-input-val" value="10.0" min="0.5" max="24" step="0.5" readonly>
            <button type="button" class="hh-btn-adjust hh-inc">+</button>
        </div>
    `;
    
    const inputVal = row.querySelector('.hh-input-val');
    
    row.querySelector('.hh-dec').addEventListener('click', () => {
        let val = parseFloat(inputVal.value) || 0;
        if (val > 0.5) {
            inputVal.value = (val - 0.5).toFixed(1);
            recalculateCurrentActivityHH();
        }
    });
    
    row.querySelector('.hh-inc').addEventListener('click', () => {
        let val = parseFloat(inputVal.value) || 0;
        if (val < 24) {
            inputVal.value = (val + 0.5).toFixed(1);
            recalculateCurrentActivityHH();
        }
    });
    
    hhList.appendChild(row);
}

function removeWorkerFromHHList(dni) {
    const row = document.getElementById(`hh-row-${dni}`);
    if (row) row.remove();
    
    const hhList = document.getElementById('personnel-hh-inputs');
    if (hhList.children.length === 0) {
        hhList.innerHTML = '<div class="no-data-indicator">Marque trabajadores arriba para ingresar sus horas.</div>';
    }
}

function recalculateCurrentActivityHH() {
    const rows = document.querySelectorAll('.hh-allocation-row');
    let total = 0;
    
    rows.forEach(row => {
        const hh = parseFloat(row.querySelector('.hh-input-val').value) || 0;
        total += hh;
    });
    
    document.getElementById('curr-act-workers-count').innerText = rows.length;
    document.getElementById('curr-act-hh-total').innerText = `${total.toFixed(1)} hrs`;
}

// --- MULTIACTIVIDAD: AGREGAR ACTIVIDADES A LA GRILLA ---
function addActivityToGrid() {
    const proyecto = document.getElementById('select-proyecto').value;
    const frente = document.getElementById('select-frente').value;
    const disciplina = document.getElementById('select-disciplina').value;
    const area = document.getElementById('select-area').value;
    const activityId = document.getElementById('select-activity-id').value;
    const actividad = document.getElementById('display-actividad-nombre').value;
    const unidad = document.getElementById('display-actividad-unidad').value;
    const metrado = parseFloat(document.getElementById('input-metrado-ejecutado').value);
    
    // Validaciones de Actividad
    if (!activityId || !actividad) {
        showToast('Debe seleccionar una actividad mediante los filtros en cascada.', 'danger');
        return;
    }
    
    if (isNaN(metrado) || metrado <= 0) {
        showToast('El Metrado Ejecutado debe ser un número mayor a 0.', 'danger');
        return;
    }
    
    // Validar trabajadores asignados
    const workerRows = document.querySelectorAll('.hh-allocation-row');
    if (workerRows.length === 0) {
        showToast('Debe asignar al menos un trabajador a esta actividad.', 'danger');
        return;
    }
    
    const assignedPersonnel = [];
    let actHHTotal = 0;
    
    for (const row of workerRows) {
        const hh = parseFloat(row.querySelector('.hh-input-val').value) || 0;
        if (hh <= 0) {
            showToast('Las Horas Hombre (HH) deben ser mayores a 0.', 'danger');
            return;
        }
        
        assignedPersonnel.push({
            dni: parseInt(row.dataset.dni),
            nombre: row.dataset.name,
            categoria: row.dataset.category,
            hh: hh
        });
        actHHTotal += hh;
    }
    
    // Comprobar si la actividad ya está en la grilla
    const exists = activeReportActivities.some(a => a.activityId === activityId);
    if (exists) {
        showToast('Esta actividad ya se encuentra en la grilla.', 'warning');
        return;
    }
    
    // Añadir al estado
    activeReportActivities.push({
        id: `ACT-${Date.now()}-${activityId}`,
        proyecto,
        frente,
        disciplina,
        area,
        activityId,
        actividad,
        unidad,
        metrado,
        personal: assignedPersonnel,
        hhTotal: actHHTotal
    });
    
    // Refrescar vistas
    renderActivitiesGrid();
    updateGeneralReportTotals();
    updateEvidenciaActivitiesDropdown();
    
    // Resetear formulario de captura
    document.getElementById('input-metrado-ejecutado').value = '';
    resetCascadingSelectsFrom('frente');
    document.getElementById('select-proyecto').value = '';
    
    // Desmarcar personal
    document.querySelectorAll('.personnel-checkbox-card').forEach(card => {
        card.classList.remove('checked');
        const chk = card.querySelector('input');
        if (chk) chk.checked = false;
    });
    document.getElementById('personnel-hh-inputs').innerHTML = '<div class="no-data-indicator">Marque trabajadores arriba para ingresar sus horas.</div>';
    recalculateCurrentActivityHH();
    
    showToast('Actividad agregada con éxito.', 'success');
}

function renderActivitiesGrid() {
    const tbody = document.getElementById('activities-grid-body');
    tbody.innerHTML = '';
    
    if (activeReportActivities.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="center-text text-muted padding-lg">
                    Aún no se han agregado actividades a este reporte diario.
                </td>
            </tr>
        `;
        return;
    }
    
    activeReportActivities.forEach((act, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <span class="grid-act-code">${act.activityId}</span>
                <span class="grid-act-desc">${act.actividad}</span>
            </td>
            <td>
                <span>${act.frente}</span>
                <br>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${act.area}</span>
            </td>
            <td>
                <strong>${act.metrado.toFixed(2)}</strong>
                <span class="grid-act-unity">${act.unidad}</span>
            </td>
            <td>
                <span>👥 ${act.personal.length}</span>
            </td>
            <td>
                <strong>${act.hhTotal.toFixed(1)}h</strong>
            </td>
            <td class="center-text">
                <button type="button" class="btn-icon-delete" title="Quitar actividad">🗑️</button>
            </td>
        `;
        
        tr.querySelector('.btn-icon-delete').addEventListener('click', () => {
            removeActivityFromGrid(index);
        });
        
        tbody.appendChild(tr);
    });
}

function removeActivityFromGrid(index) {
    const act = activeReportActivities[index];
    
    // Quitar fotos asociadas a este Activity ID
    attachedPhotos = attachedPhotos.filter(p => p.activityId !== act.activityId);
    
    activeReportActivities.splice(index, 1);
    renderActivitiesGrid();
    updateGeneralReportTotals();
    updateEvidenciaActivitiesDropdown();
    renderPhotosGallery();
    
    showToast('Actividad removida.', 'info');
}

function updateGeneralReportTotals() {
    const actCount = activeReportActivities.length;
    
    // Trabajadores únicos
    const allDnis = [];
    let hhTotal = 0;
    
    activeReportActivities.forEach(act => {
        act.personal.forEach(p => {
            allDnis.push(p.dni);
            hhTotal += p.hh;
        });
    });
    
    const uniqueWorkersCount = new Set(allDnis).size;
    
    document.getElementById('report-summary-activities-count').innerText = actCount;
    document.getElementById('report-summary-workers-count').innerText = uniqueWorkersCount;
    document.getElementById('report-summary-hh-total').innerText = hhTotal.toFixed(1);
}

function updateEvidenciaActivitiesDropdown() {
    const select = document.getElementById('select-photo-activity');
    select.innerHTML = '';
    
    if (activeReportActivities.length === 0) {
        select.innerHTML = '<option value="" disabled selected>Agregue actividades primero...</option>';
        return;
    }
    
    select.innerHTML = '<option value="" disabled selected>Asociar a...</option>';
    
    // Opción General
    const generalOpt = document.createElement('option');
    generalOpt.value = 'GENERAL';
    generalOpt.innerText = 'General (Todo el Reporte)';
    select.appendChild(generalOpt);
    
    activeReportActivities.forEach(act => {
        const opt = document.createElement('option');
        opt.value = act.activityId;
        opt.innerText = `[${act.activityId}] ${act.actividad}`;
        select.appendChild(opt);
    });
    
    select.value = 'GENERAL';
}

// --- EVIDENCIAS FOTOGRÁFICAS ---
function handlePhotoSelection(e) {
    const files = e.target.files;
    const activityId = document.getElementById('select-photo-activity').value;
    
    if (!activityId) {
        showToast('Seleccione primero a qué actividad asociar la foto.', 'warning');
        return;
    }
    
    if (!files || files.length === 0) return;
    
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (event) => {
            attachedPhotos.push({
                file: file,
                dataUrl: event.target.result,
                activityId: activityId,
                filename: file.name
            });
            renderPhotosGallery();
        };
        reader.readAsDataURL(file);
    });
    
    // Resetear input file
    e.target.value = '';
}

function renderPhotosGallery() {
    const gallery = document.getElementById('photos-preview-gallery');
    gallery.innerHTML = '';
    
    if (attachedPhotos.length === 0) {
        gallery.innerHTML = '<div class="no-photos-indicator">No hay fotografías adjuntas en este reporte.</div>';
        return;
    }
    
    attachedPhotos.forEach((photo, index) => {
        const card = document.createElement('div');
        card.className = 'photo-item-card';
        card.innerHTML = `
            <img src="${photo.dataUrl}" alt="Evidencia">
            <span class="photo-item-delete-btn">&times;</span>
            <span class="photo-item-badge">${photo.activityId === 'GENERAL' ? 'Reporte General' : `ID: ${photo.activityId}`}</span>
        `;
        
        card.querySelector('.photo-item-delete-btn').addEventListener('click', () => {
            attachedPhotos.splice(index, 1);
            renderPhotosGallery();
        });
        
        gallery.appendChild(card);
    });
}

// --- CARGA DE FOTOS TEMPORAL PARA OBTENER URL PÚBLICA (tmpfiles.org) ---
async function uploadPhotoToPublicUrl(photoObj) {
    try {
        // Convertir dataUrl a Blob
        const blob = dataURItoBlob(photoObj.dataUrl);
        const formData = new FormData();
        formData.append('file', blob, photoObj.filename);
        
        const response = await fetch('https://tmpfiles.org/api/v1/upload', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Error HTTP tmpfiles: ${response.status}`);
        }
        
        const resJson = await response.json();
        
        if (resJson.status === 'success') {
            // Transformar la URL para descarga directa requerida por Airtable
            // URL original: https://tmpfiles.org/12345/file.png
            // URL directa: https://tmpfiles.org/dl/12345/file.png
            const url = resJson.data.url;
            const directUrl = url.replace('https://tmpfiles.org/', 'https://tmpfiles.org/dl/');
            return directUrl;
        } else {
            throw new Error('Fallo al subir a tmpfiles');
        }
    } catch (err) {
        console.error('Error al subir imagen:', err);
        return null;
    }
}

function dataURItoBlob(dataURI) {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
}

// --- ENVÍO DE REPORTE DIARIO COMPLETO A AIRTABLE (TRANSACCIONAL) ---
async function submitReportToAirtable() {
    const turno = document.getElementById('report-select-turno').value;
    const supervisor = document.getElementById('report-select-supervisor').value;
    
    // Validaciones
    if (!turno) {
        showToast('El campo Turno es obligatorio.', 'danger');
        return;
    }
    if (!supervisor) {
        showToast('El campo Supervisor es obligatorio.', 'danger');
        return;
    }
    if (activeReportActivities.length === 0) {
        showToast('Debe agregar al menos una actividad al reporte.', 'danger');
        return;
    }
    
    const now = new Date();
    const dateIsoStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Generar ID único del reporte
    const reportId = `REP-${Date.now()}`;
    
    showSpinner('Subiendo fotografías de evidencia...');
    
    // 1. Subir imágenes secuencialmente a tmpfiles y conseguir URLs directas
    const uploadedPhotosWithUrls = [];
    for (const photo of attachedPhotos) {
        const publicUrl = await uploadPhotoToPublicUrl(photo);
        if (publicUrl) {
            uploadedPhotosWithUrls.push({
                activityId: photo.activityId,
                url: publicUrl
            });
        }
    }
    
    showSpinner('Registrando cabecera del reporte...');
    
    try {
        // 2. Crear maestro de reporte
        const reportFields = {
            'ID Reporte': reportId,
            'Fecha': dateIsoStr,
            'Turno': turno,
            'Supervisor': supervisor,
            'Usuario': currentUser.Usuario,
            'Fecha Registro': dateIsoStr,
            'Hora Registro': timeStr
        };
        await createAirtableRecords('Reportes', [reportFields]);
        
        // 3. Crear registros de actividades
        showSpinner('Guardando actividades de producción...');
        const activitiesFieldsArray = activeReportActivities.map(act => ({
            'ID': act.id,
            'Reporte': reportId,
            'Proyecto': act.proyecto,
            'Frente': act.frente,
            'Disciplina': act.disciplina,
            'Area': act.area,
            'Activity ID': act.activityId,
            'Actividad': act.actividad,
            'Unidad': act.unidad,
            'Metrado': act.metrado
        }));
        await createAirtableRecords('Reporte Actividades', activitiesFieldsArray);
        
        // 4. Crear registros de HH del personal
        showSpinner('Guardando asistencia y HH del personal...');
        const personalFieldsArray = [];
        activeReportActivities.forEach(act => {
            act.personal.forEach(p => {
                personalFieldsArray.push({
                    'ID': `${act.id}-${p.dni}`,
                    'Reporte': reportId,
                    'Activity ID': act.activityId,
                    'Personal': p.nombre,
                    'Categoría': p.categoria,
                    'HH': p.hh
                });
            });
        });
        await createAirtableRecords('Reporte Personal', personalFieldsArray);
        
        // 5. Registrar Evidencias
        if (uploadedPhotosWithUrls.length > 0) {
            showSpinner('Guardando enlaces de evidencias en Airtable...');
            const evidenciasFieldsArray = uploadedPhotosWithUrls.map((photo, idx) => ({
                'ID': `${reportId}-${photo.activityId}-${idx}`,
                'Reporte': reportId,
                'Activity ID': photo.activityId,
                'Fotografía': [{ url: photo.url }],
                'Fecha': now.toISOString()
            }));
            await createAirtableRecords('Evidencias', evidenciasFieldsArray);
        }
        
        showToast('Reporte guardado correctamente.', 'success');
        
        // Resetear Formulario
        initializeReportForm();
        
        // Redirigir al Log Histórico
        switchTab('tab-history-reports');
        
    } catch (err) {
        console.error('Error al guardar el reporte diario completo:', err);
        showToast(`Error al guardar reporte: ${err.message}`, 'danger');
    } finally {
        hideSpinner();
    }
}

// --- CARGAR HISTORIAL DE REPORTES COMPLETO DESDE AIRTABLE ---
async function loadHistoricalLog() {
    const tbody = document.getElementById('history-list-body');
    tbody.innerHTML = '<tr><td colspan="10" class="center-text text-muted padding-lg">Consultando Airtable...</td></tr>';
    
    try {
        // Cargar todos los datos históricos
        const [repRecords, actRecords, persRecords, evRecords] = await Promise.all([
            fetchAirtableRecords('Reportes'),
            fetchAirtableRecords('Reporte Actividades'),
            fetchAirtableRecords('Reporte Personal'),
            fetchAirtableRecords('Evidencias')
        ]);
        
        historicalReports = repRecords.map(r => r.fields);
        historicalActivities = actRecords.map(r => r.fields);
        historicalPersonal = persRecords.map(r => r.fields);
        historicalEvidencias = evRecords.map(r => r.fields);
        
        // Ordenar reportes por fecha descendiente
        historicalReports.sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha));
        
        // Popular filtros con los datos obtenidos
        populateHistoricalFilterOptions();
        
        // Renderizar tabla
        renderHistoryTable(historicalReports);
        
        // Actualizar el Dashboard si los datos están disponibles
        if (window.updateDashboardKPIs) {
            window.updateDashboardKPIs();
        }
        
        updateConnectionStatus(true);
    } catch (err) {
        console.error('Error al cargar historial:', err);
        tbody.innerHTML = '<tr><td colspan="10" class="center-text danger padding-lg">Error al conectar con Airtable.</td></tr>';
        updateConnectionStatus(false);
    }
}

function populateHistoricalFilterOptions() {
    const proyectoSelect = document.getElementById('filter-history-proyecto');
    const frenteSelect = document.getElementById('filter-history-frente');
    const discSelect = document.getElementById('filter-history-disciplina');
    const areaSelect = document.getElementById('filter-history-area');
    const supSelect = document.getElementById('filter-history-supervisor');
    
    // Respaldar selecciones anteriores
    const prevProj = proyectoSelect.value;
    const prevFrente = frenteSelect.value;
    const prevDisc = discSelect.value;
    const prevArea = areaSelect.value;
    const prevSup = supSelect.value;
    
    // Rellenar
    proyectoSelect.innerHTML = '<option value="">Todos los Proyectos</option>';
    frenteSelect.innerHTML = '<option value="">Todos los Frentes</option>';
    discSelect.innerHTML = '<option value="">Todas las Disciplinas</option>';
    areaSelect.innerHTML = '<option value="">Todas las Áreas</option>';
    supSelect.innerHTML = '<option value="">Todos los Supervisores</option>';
    
    const uniqueProjs = [...new Set(historicalActivities.map(a => a.Proyecto))].filter(Boolean).sort();
    const uniqueFrentes = [...new Set(historicalActivities.map(a => a.Frente))].filter(Boolean).sort();
    const uniqueDiscs = [...new Set(historicalActivities.map(a => a.Disciplina))].filter(Boolean).sort();
    const uniqueAreas = [...new Set(historicalActivities.map(a => a.Area))].filter(Boolean).sort();
    const uniqueSups = [...new Set(historicalReports.map(r => r.Supervisor))].filter(Boolean).sort();
    
    uniqueProjs.forEach(p => proyectoSelect.appendChild(new Option(p, p)));
    uniqueFrentes.forEach(f => frenteSelect.appendChild(new Option(f, f)));
    uniqueDiscs.forEach(d => discSelect.appendChild(new Option(d, d)));
    uniqueAreas.forEach(a => areaSelect.appendChild(new Option(a, a)));
    uniqueSups.forEach(s => supSelect.appendChild(new Option(s, s)));
    
    // Restaurar si existen
    proyectoSelect.value = prevProj;
    frenteSelect.value = prevFrente;
    discSelect.value = prevDisc;
    areaSelect.value = prevArea;
    supSelect.value = prevSup;
}

function renderHistoryTable(reports) {
    const tbody = document.getElementById('history-list-body');
    tbody.innerHTML = '';
    
    if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="center-text text-muted padding-lg">No se encontraron reportes.</td></tr>';
        return;
    }
    
    reports.forEach(rep => {
        const repId = rep['ID Reporte'];
        
        // Calcular consolidados para esta fila
        const acts = historicalActivities.filter(a => a.Reporte === repId);
        const pers = historicalPersonal.filter(p => p.Reporte === repId);
        const evs = historicalEvidencias.filter(e => e.Reporte === repId);
        
        const actsCount = acts.length;
        const workersCount = [...new Set(pers.map(p => p.Personal))].length;
        const totalHH = pers.reduce((sum, p) => sum + (parseFloat(p.HH) || 0), 0);
        const photosCount = evs.reduce((sum, e) => sum + (e['Fotografía'] ? e['Fotografía'].length : 0), 0);
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${repId.replace('REP-', '')}</strong></td>
            <td>${rep.Fecha}</td>
            <td><span class="status-indicator-badge">${rep.Turno.toUpperCase()}</span></td>
            <td>${rep.Supervisor}</td>
            <td><span class="text-muted" style="font-size:0.8rem;">${rep.Usuario}</span></td>
            <td class="center-text">${actsCount}</td>
            <td class="center-text">${workersCount}</td>
            <td class="center-text"><strong>${totalHH.toFixed(1)}h</strong></td>
            <td class="center-text">📸 ${photosCount}</td>
            <td class="center-text">
                <button type="button" class="btn btn-outline btn-small btn-view-report-detail" data-id="${repId}">Ver</button>
            </td>
        `;
        
        tr.querySelector('.btn-view-report-detail').addEventListener('click', () => {
            showReportDetailsModal(repId);
        });
        
        tbody.appendChild(tr);
    });
}

// --- FILTRADO HISTÓRICO EN CLIENTE ---
function applyHistoricalFilters() {
    const dateVal = document.getElementById('filter-history-date').value;
    const projVal = document.getElementById('filter-history-proyecto').value;
    const frenteVal = document.getElementById('filter-history-frente').value;
    const discVal = document.getElementById('filter-history-disciplina').value;
    const areaVal = document.getElementById('filter-history-area').value;
    const supVal = document.getElementById('filter-history-supervisor').value;
    
    let filtered = [...historicalReports];
    
    if (dateVal) {
        filtered = filtered.filter(r => r.Fecha === dateVal);
    }
    if (supVal) {
        filtered = filtered.filter(r => r.Supervisor === supVal);
    }
    
    // Filtrar por actividad asociadas
    if (projVal || frenteVal || discVal || areaVal) {
        filtered = filtered.filter(r => {
            const rId = r['ID Reporte'];
            const acts = historicalActivities.filter(a => a.Reporte === rId);
            return acts.some(act => {
                if (projVal && act.Proyecto !== projVal) return false;
                if (frenteVal && act.Frente !== frenteVal) return false;
                if (discVal && act.Disciplina !== discVal) return false;
                if (areaVal && act.Area !== areaVal) return false;
                return true;
            });
        });
    }
    
    renderHistoryTable(filtered);
    showToast('Filtros aplicados.', 'info');
}

function clearHistoricalFilters() {
    document.getElementById('filter-history-date').value = '';
    document.getElementById('filter-history-proyecto').value = '';
    document.getElementById('filter-history-frente').value = '';
    document.getElementById('filter-history-disciplina').value = '';
    document.getElementById('filter-history-area').value = '';
    document.getElementById('filter-history-supervisor').value = '';
    
    renderHistoryTable(historicalReports);
    showToast('Filtros limpiados.', 'info');
}

// --- EXPORTACIÓN EXCEL CON SHEETJS ---
function exportHistoryToExcel() {
    try {
        if (historicalReports.length === 0) {
            showToast('No hay datos de reportes para exportar.', 'warning');
            return;
        }
        
        // 1. Cabeceras
        const reportData = historicalReports.map(r => {
            const acts = historicalActivities.filter(a => a.Reporte === r['ID Reporte']);
            const pers = historicalPersonal.filter(p => p.Reporte === r['ID Reporte']);
            return {
                'ID Reporte': r['ID Reporte'],
                'Fecha': r.Fecha,
                'Turno': r.Turno,
                'Supervisor': r.Supervisor,
                'Usuario Registro': r.Usuario,
                'Fecha Registro': r['Fecha Registro'],
                'Hora Registro': r['Hora Registro'],
                'Total Actividades': acts.length,
                'Total Personal Involucrado': [...new Set(pers.map(p => p.Personal))].length,
                'Horas Hombre Totales (HH)': pers.reduce((sum, p) => sum + (parseFloat(p.HH) || 0), 0)
            };
        });
        
        // 2. Actividades Detalle
        const activityData = historicalActivities.map(a => ({
            'ID Reporte': a.Reporte,
            'Proyecto': a.Proyecto,
            'Frente': a.Frente,
            'Disciplina': a.Disciplina,
            'Área': a.Area,
            'Activity ID': a['Activity ID'],
            'Actividad': a.Actividad,
            'Unidad': a.Unidad,
            'Metrado': a.Metrado
        }));
        
        // 3. Personal Detalle
        const personalData = historicalPersonal.map(p => ({
            'ID Reporte': p.Reporte,
            'Activity ID': p['Activity ID'],
            'Personal': p.Personal,
            'Categoría': p.Categoría,
            'HH Asignadas': p.HH
        }));
        
        // Crear libro Excel
        const wb = XLSX.utils.book_new();
        
        const wsReports = XLSX.utils.json_to_sheet(reportData);
        const wsActivities = XLSX.utils.json_to_sheet(activityData);
        const wsPersonal = XLSX.utils.json_to_sheet(personalData);
        
        XLSX.utils.book_append_sheet(wb, wsReports, 'Resumen Reportes');
        XLSX.utils.book_append_sheet(wb, wsActivities, 'Detalle Actividades');
        XLSX.utils.book_append_sheet(wb, wsPersonal, 'Detalle Personal HH');
        
        // Descargar
        XLSX.writeFile(wb, `Reporte_Diario_Consolidado_${Date.now()}.xlsx`);
        showToast('Archivo Excel generado y descargado.', 'success');
    } catch (err) {
        console.error('Error al generar Excel:', err);
        showToast('Error al exportar a Excel.', 'danger');
    }
}

// --- MODAL DETALLE DE REPORTE ---
function showReportDetailsModal(reportId) {
    const report = historicalReports.find(r => r['ID Reporte'] === reportId);
    if (!report) return;
    
    // Cabecera
    document.getElementById('modal-report-id').innerText = `Detalle de Reporte: ${reportId}`;
    document.getElementById('modal-date').innerText = report.Fecha;
    document.getElementById('modal-turno').innerText = report.Turno.toUpperCase();
    document.getElementById('modal-supervisor').innerText = report.Supervisor;
    document.getElementById('modal-usuario').innerText = report.Usuario;
    document.getElementById('modal-timestamp').innerText = `${report['Fecha Registro']} a las ${report['Hora Registro']}`;
    
    // Actividades
    const acts = historicalActivities.filter(a => a.Reporte === reportId);
    const actsBody = document.getElementById('modal-activities-body');
    actsBody.innerHTML = '';
    acts.forEach(a => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong class="grid-act-code">${a['Activity ID']}</strong></td>
            <td>${a.Actividad}</td>
            <td class="center-text"><span class="grid-act-unity">${a.Unidad}</span></td>
            <td>${a.Proyecto}</td>
            <td>${a.Frente} <br> <span style="font-size:0.75rem; color:var(--text-muted);">${a.Area}</span></td>
            <td><strong>${(a.Metrado || 0).toFixed(2)}</strong></td>
        `;
        actsBody.appendChild(tr);
    });
    
    // Personal y HH
    const pers = historicalPersonal.filter(p => p.Reporte === reportId);
    const persBody = document.getElementById('modal-personal-body');
    persBody.innerHTML = '';
    pers.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${p.Personal}</strong></td>
            <td>${p.Categoría}</td>
            <td><span class="grid-act-code">${p['Activity ID']}</span></td>
            <td class="center-text"><strong>${(p.HH || 0).toFixed(1)} hrs</strong></td>
        `;
        persBody.appendChild(tr);
    });
    
    // Evidencias (Fotos)
    const evs = historicalEvidencias.filter(e => e.Reporte === reportId);
    const gallery = document.getElementById('modal-photos-gallery');
    gallery.innerHTML = '';
    
    let totalPhotos = 0;
    evs.forEach(e => {
        const photos = e['Fotografía'];
        if (photos && Array.isArray(photos)) {
            photos.forEach(p => {
                totalPhotos++;
                const box = document.createElement('div');
                box.className = 'modal-photo-box';
                box.innerHTML = `<img src="${p.url}" alt="Evidencia ${e['Activity ID']}" title="Actividad: ${e['Activity ID']}">`;
                // Zoom
                box.addEventListener('click', () => {
                    window.open(p.url, '_blank');
                });
                gallery.appendChild(box);
            });
        }
    });
    
    if (totalPhotos === 0) {
        gallery.innerHTML = '<div class="no-photos-indicator">No se adjuntaron fotografías en este reporte.</div>';
    }
    
    document.getElementById('report-detail-modal').classList.remove('hidden');
}

function hideModal() {
    document.getElementById('report-detail-modal').classList.add('hidden');
}

// --- UTILERÍAS ---
function showSpinner(text) {
    document.getElementById('spinner-status-text').innerText = text;
    document.getElementById('global-spinner').classList.remove('hidden');
}

function hideSpinner() {
    document.getElementById('global-spinner').classList.add('hidden');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast-item ${type}`;
    toast.style.setProperty('--delay', '4.5s');
    
    toast.innerHTML = `
        <span>${message}</span>
        <span class="toast-close-btn">&times;</span>
    `;
    
    toast.querySelector('.toast-close-btn').addEventListener('click', () => {
        toast.remove();
    });
    
    container.appendChild(toast);
    
    // Eliminar del DOM tras el timeout
    setTimeout(() => {
        if (toast.parentNode) {
            toast.remove();
        }
    }, 4800);
}

function updateConnectionStatus(isOnline) {
    const led = document.getElementById('connection-status');
    if (isOnline) {
        led.className = 'connection-led online';
        led.querySelector('.led-text').innerText = 'CONECTADO';
    } else {
        led.className = 'connection-led offline';
        led.querySelector('.led-text').innerText = 'DESCONECTADO';
        showToast('El sistema no tiene comunicación con Airtable.', 'warning');
    }
}

// --- EXPORTAR INTERFACES A NIVEL GLOBAL ---
window.showSpinner = showSpinner;
window.hideSpinner = hideSpinner;
window.showToast = showToast;
window.historicalReports = () => historicalReports;
window.historicalActivities = () => historicalActivities;
window.historicalPersonal = () => historicalPersonal;
window.historicalEvidencias = () => historicalEvidencias;
