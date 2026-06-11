/* ==========================================================================
   CONSTRUTECH - EXECUTIVE DASHBOARD LOGIC (dashboard.js)
   ========================================================================== */

let myCharts = {
    disciplineChart: null,
    weeklyChart: null,
    areaChart: null
};

// Paleta de colores para gráficos en armonía con el diseño industrial oscuro
const chartColors = {
    primaryAmber: '#ff9f0a',
    primaryGold: '#ffc72c',
    successEmerald: '#10b981',
    infoBlue: '#3b82f6',
    accentOrange: '#f97316',
    accentPurple: '#8b5cf6',
    borderDark: '#1e293b',
    textSecondary: '#acb9ca',
    textMuted: '#64748b',
    glowColor: 'rgba(255, 159, 10, 0.1)'
};

// Registrar refresco del dashboard
document.addEventListener('DOMContentLoaded', () => {
    // Vincular al nivel global para que app.js lo llame tras cargar historial
    window.updateDashboardKPIs = updateDashboardKPIs;
    window.renderDashboardCharts = renderDashboardCharts;
});

// --- CÁLCULO Y ACTUALIZACIÓN DE KPIs ---
function updateDashboardKPIs() {
    const reports = window.historicalReports ? window.historicalReports() : [];
    const activities = window.historicalActivities ? window.historicalActivities() : [];
    const personal = window.historicalPersonal ? window.historicalPersonal() : [];
    
    // 1. Obtener fecha de hoy en formato local YYYY-MM-DD
    const todayStr = new Date().toISOString().split('T')[0];
    
    // 2. Filtrar reportes de hoy
    const reportsToday = reports.filter(r => r.Fecha === todayStr);
    const reportIdsToday = reportsToday.map(r => r['ID Reporte']);
    
    // --- METRADO DIARIO Y ACUMULADO ---
    let metradoDiario = 0;
    let metradoAcumulado = 0;
    
    activities.forEach(act => {
        const m = parseFloat(act.Metrado) || 0;
        metradoAcumulado += m;
        if (reportIdsToday.includes(act.Reporte)) {
            metradoDiario += m;
        }
    });
    
    // --- HH DIARIAS Y ACUMULADAS ---
    let hhDiarias = 0;
    let hhAcumuladas = 0;
    
    personal.forEach(p => {
        const hh = parseFloat(p.HH) || 0;
        hhAcumuladas += hh;
        if (reportIdsToday.includes(p.Reporte)) {
            hhDiarias += hh;
        }
    });
    
    // --- PRODUCTIVIDAD GLOBAL (HH / Unidad) ---
    // Promedio consolidado de HH por cada unidad de metrado general
    let productividad = 0;
    if (metradoAcumulado > 0) {
        productividad = hhAcumuladas / metradoAcumulado;
    }
    
    // --- ACTIVIDADES EJECUTADAS (Actividades Únicas) ---
    const uniqueActivityIds = [...new Set(activities.map(a => a['Activity ID']))].length;
    
    // --- RENDERIZAR KPIs EN PANTALLA ---
    document.getElementById('kpi-metrado-diario').innerText = metradoDiario.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('kpi-metrado-acumulado').innerText = metradoAcumulado.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    document.getElementById('kpi-hh-diarias').innerText = hhDiarias.toFixed(1);
    document.getElementById('kpi-hh-acumuladas').innerText = hhAcumuladas.toFixed(1);
    
    document.getElementById('kpi-productividad').innerText = productividad.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('kpi-actividades-count').innerText = uniqueActivityIds;
}

// --- RENDERIZADO DE GRÁFICOS INTERACTIVOS (CHART.JS) ---
function renderDashboardCharts() {
    const activities = window.historicalActivities ? window.historicalActivities() : [];
    const personal = window.historicalPersonal ? window.historicalPersonal() : [];
    const reports = window.historicalReports ? window.historicalReports() : [];
    
    // Asegurarse de que hay datos
    if (reports.length === 0) {
        console.log('No hay datos históricos suficientes para graficar.');
        return;
    }
    
    // --- 1. GRÁFICO: ACTIVIDADES POR DISCIPLINA (DOUGHNUT) ---
    const disciplineHH = {};
    personal.forEach(p => {
        // Encontrar la actividad correspondiente para identificar la disciplina
        const act = activities.find(a => a.Reporte === p.Reporte && a['Activity ID'] === p['Activity ID']);
        if (act) {
            const disc = act.Disciplina || 'Sin Disciplina';
            disciplineHH[disc] = (disciplineHH[disc] || 0) + (parseFloat(p.HH) || 0);
        }
    });
    
    renderDisciplineDoughnut(disciplineHH);
    
    // --- 2. GRÁFICO: TENDENCIA SEMANAL (BARRA/LÍNEA DE HH DIARIAS) ---
    // Agrupar HH por fecha de reporte en los últimos 7 días con reportes
    const datesList = [...new Set(reports.map(r => r.Fecha))].sort();
    const last7Dates = datesList.slice(-7); // Últimas 7 fechas registradas
    
    const weeklyData = {};
    last7Dates.forEach(d => {
        weeklyData[d] = 0;
    });
    
    personal.forEach(p => {
        const rep = reports.find(r => r['ID Reporte'] === p.Reporte);
        if (rep && last7Dates.includes(rep.Fecha)) {
            weeklyData[rep.Fecha] += (parseFloat(p.HH) || 0);
        }
    });
    
    renderWeeklyTrend(weeklyData);
    
    // --- 3. GRÁFICO: CONSUMO DE HH POR ÁREA DE PERSONAL (HORIZONTAL BAR) ---
    const areaHH = {};
    personal.forEach(p => {
        // El campo 'Categoría' nos da la categoría del personal, pero también podemos buscar su Área real del maestro o guardada en 'Reporte Personal'
        // Si no está el Área directamente en el reporte de personal, agrupamos por Categoría o nombre
        // En nuestro Reporte Personal, guardamos 'Categoría' (ej: Oficial Electricista, etc.)
        // O también podemos usar la categoría del personal guardada
        const label = p['Categoría'] || 'Varios';
        areaHH[label] = (areaHH[label] || 0) + (parseFloat(p.HH) || 0);
    });
    
    // Ordenar y recortar a top 6 para mejor legibilidad móvil
    const sortedAreas = Object.entries(areaHH)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
        
    const topAreaHH = {};
    sortedAreas.forEach(([k, v]) => {
        topAreaHH[k] = v;
    });
    
    renderAreaBar(topAreaHH);
}

// --- GRÁFICO 1: DOUGHNUT DISCIPLINA ---
function renderDisciplineDoughnut(dataObj) {
    const ctx = document.getElementById('chart-activities-discipline').getContext('2d');
    
    if (myCharts.disciplineChart) {
        myCharts.disciplineChart.destroy();
    }
    
    const labels = Object.keys(dataObj);
    const values = Object.values(dataObj);
    
    if (labels.length === 0) {
        showNoDataText(ctx, 'chart-activities-discipline');
        return;
    }
    
    myCharts.disciplineChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: [
                    chartColors.primaryGold,
                    chartColors.infoBlue,
                    chartColors.successEmerald,
                    chartColors.accentOrange,
                    chartColors.accentPurple,
                    '#f43f5e',
                    '#14b8a6'
                ],
                borderWidth: 2,
                borderColor: '#0e1522'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: chartColors.textSecondary,
                        font: { family: 'Inter', size: 11, weight: '500' },
                        padding: 12
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const val = context.raw;
                            return ` ${context.label}: ${val.toFixed(1)} hrs-hombre`;
                        }
                    }
                }
            }
        }
    });
}

// --- GRÁFICO 2: TENDENCIA SEMANAL ---
function renderWeeklyTrend(dataObj) {
    const ctx = document.getElementById('chart-weekly-trend').getContext('2d');
    
    if (myCharts.weeklyChart) {
        myCharts.weeklyChart.destroy();
    }
    
    // Formatear fechas de YYYY-MM-DD a DD/MM
    const rawLabels = Object.keys(dataObj);
    const labels = rawLabels.map(dateStr => {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            return `${parts[2]}/${parts[1]}`;
        }
        return dateStr;
    });
    const values = Object.values(dataObj);
    
    if (labels.length === 0) {
        showNoDataText(ctx, 'chart-weekly-trend');
        return;
    }
    
    myCharts.weeklyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'HH Diarias',
                data: values,
                backgroundColor: 'rgba(255, 159, 10, 0.75)',
                borderColor: chartColors.primaryAmber,
                borderWidth: 1.5,
                borderRadius: 4,
                hoverBackgroundColor: chartColors.primaryGold
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return ` ${context.parsed.y.toFixed(1)} HH`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.04)' },
                    ticks: { color: chartColors.textSecondary, font: { family: 'Inter', size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.04)' },
                    ticks: { color: chartColors.textSecondary, font: { family: 'Inter', size: 10 } },
                    title: {
                        display: true,
                        text: 'Horas Hombre (HH)',
                        color: chartColors.textSecondary,
                        font: { size: 11, weight: 'bold' }
                    }
                }
            }
        }
    });
}

// --- GRÁFICO 3: HH POR ÁREA DE PERSONAL ---
function renderAreaBar(dataObj) {
    const ctx = document.getElementById('chart-hh-personnel-area').getContext('2d');
    
    if (myCharts.areaChart) {
        myCharts.areaChart.destroy();
    }
    
    const labels = Object.keys(dataObj);
    const values = Object.values(dataObj);
    
    if (labels.length === 0) {
        showNoDataText(ctx, 'chart-hh-personnel-area');
        return;
    }
    
    myCharts.areaChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: 'rgba(16, 185, 129, 0.7)',
                borderColor: chartColors.successEmerald,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y', // Barra Horizontal
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return ` ${context.parsed.x.toFixed(1)} HH`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.04)' },
                    ticks: { color: chartColors.textSecondary, font: { family: 'Inter', size: 10 } },
                    title: {
                        display: true,
                        text: 'Consumo HH',
                        color: chartColors.textSecondary,
                        font: { size: 11, weight: 'bold' }
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: { 
                        color: chartColors.textSecondary, 
                        font: { family: 'Inter', size: 9 },
                        callback: function(value) {
                            // Truncar etiquetas largas en móvil
                            const label = this.getLabelForValue(value);
                            return label.length > 18 ? label.substring(0, 16) + '..' : label;
                        }
                    }
                }
            }
        }
    });
}

// Mostrar texto "sin datos" cuando no hay registros para evitar error visual
function showNoDataText(ctx, canvasId) {
    const canvas = document.getElementById(canvasId);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = chartColors.textMuted;
    ctx.font = '13px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('Sin datos registrados en el período.', canvas.width / 2, canvas.height / 2);
}
