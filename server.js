const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const simpleGit = require('simple-git');
const multer = require('multer');
const os = require('os');
const pidusage = require('pidusage');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const BOTS_DIR = path.join(__dirname, 'bots');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

// Crear carpetas
[dataDir, botsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(botsFile)) fs.writeFileSync(botsFile, JSON.stringify([], null, 2));

// Configurar multer para subida de archivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const botId = req.params.id;
        const uploadDir = path.join(botsDir, botId, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// ===== MIDDLEWARES =====
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== FUNCIONES AUXILIARES =====
function cargarBots() { return JSON.parse(fs.readFileSync(botsFile, 'utf-8')); }
function guardarBots(data) { fs.writeFileSync(botsFile, JSON.stringify(data, null, 2)); }

const procesos = {};

function agregarLog(botId, tipo, mensaje) {
    const bots = cargarBots();
    const bot = bots.find(b => b.id === botId);
    if (bot) {
        bot.logs = bot.logs || [];
        bot.logs.push({ fecha: new Date().toISOString(), tipo, mensaje });
        if (bot.logs.length > 500) bot.logs = bot.logs.slice(-500);
        guardarBots(bots);
    }
}

// ===== API REST =====

// Obtener estadísticas del sistema
app.get('/api/stats', async (req, res) => {
    try {
        const cpuUsage = (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1);
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const ramPercent = ((usedMem / totalMem) * 100).toFixed(1);
        
        let diskInfo = { total: 0, used: 0 };
        try {
            const { stdout } = await exec('df -k ' + botsDir);
            const lines = stdout.trim().split('\n');
            if (lines[1]) {
                const parts = lines[1].split(/\s+/);
                diskInfo = { total: parseInt(parts[1]) * 1024, used: parseInt(parts[2]) * 1024 };
            }
        } catch (e) {}
        
        const bots = cargarBots();
        const botsActivos = bots.filter(b => b.estado === 'activo').length;
        
        res.json({
            cpu: parseFloat(cpuUsage),
            ram: { total: totalMem, used: usedMem, percent: parseFloat(ramPercent) },
            disk: diskInfo,
            botsTotal: bots.length,
            botsActivos,
            uptime: process.uptime()
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Listar bots
app.get('/api/bots', (req, res) => res.json(cargarBots()));

// Crear bot
app.post('/api/bots', (req, res) => {
    const { nombre, repoUrl } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    
    const id = uuidv4().substring(0, 8);
    const botDir = path.join(botsDir, id);
    fs.mkdirSync(botDir, { recursive: true });
    
    const nuevoBot = {
        id, nombre, repoUrl: repoUrl || '', estado: 'apagado',
        creado: new Date().toISOString(), carpeta: botDir, logs: []
    };
    
    const bots = cargarBots();
    bots.push(nuevoBot);
    guardarBots(bots);
    
    // Clonar repo si hay URL
    if (repoUrl) {
        simpleGit(botDir).clone(repoUrl, botDir).then(() => {
            agregarLog(id, 'info', '✅ Repositorio clonado correctamente');
            io.emit('log', { botId: id, tipo: 'success', mensaje: '✅ Repo clonado' });
        }).catch(err => {
            agregarLog(id, 'error', '❌ Error al clonar: ' + err.message);
        });
    }
    
    io.emit('bot_creado', nuevoBot);
    res.json(nuevoBot);
});

// Reiniciar configuración (reclonar repo)
app.post('/api/bots/:id/reclone', async (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    if (!bot.repoUrl) return res.status(400).json({ error: 'No hay URL de repo' });
    
    if (procesos[id]) {
        procesos[id].kill('SIGTERM');
        delete procesos[id];
    }
    
    // Limpiar carpeta y reclonar
    fs.rmSync(bot.carpeta, { recursive: true, force: true });
    fs.mkdirSync(bot.carpeta, { recursive: true });
    
    try {
        await simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta);
        bot.estado = 'apagado';
        guardarBots(bots);
        io.emit('log', { botId: id, tipo: 'success', mensaje: '✅ Repo reclonado correctamente' });
        io.emit('bot_actualizado', bot);
        res.json({ mensaje: 'Repo reclonado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Iniciar bot
app.post('/api/bots/:id/start', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return res.status(404).json({ error: 'No encontrado' });
    if (procesos[id]) return res.json({ mensaje: 'Ya está activo' });
    
    const scriptPath = path.join(bot.carpeta, 'bot.js') || path.join(bot.carpeta, 'index.js');
    if (!fs.existsSync(scriptPath)) return res.status(400).json({ error: 'No se encontró bot.js/index.js' });
    
    try {
        const proc = spawn('node', [scriptPath], { cwd: bot.carpeta, stdio: ['pipe', 'pipe', 'pipe'] });
        procesos[id] = proc;
        bot.estado = 'activo';
        guardarBots(bots);
        
        proc.stdout.on('data', d => {
            const msg = d.toString().trim();
            io.emit('log', { botId: id, tipo: 'log', mensaje: msg });
            agregarLog(id, 'log', msg);
        });
        proc.stderr.on('data', d => {
            io.emit('log', { botId: id, tipo: 'error', mensaje: d.toString() });
        });
        proc.on('close', () => {
            delete procesos[id];
            bot.estado = 'apagado';
            guardarBots(bots);
            io.emit('bot_estado', { id, estado: 'apagado' });
        });
        
        io.emit('bot_estado', { id, estado: 'activo' });
        res.json({ mensaje: 'Iniciado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Detener bot
app.post('/api/bots/:id/stop', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) {
        procesos[id].kill('SIGTERM');
        delete procesos[id];
        const bots = cargarBots();
        const bot = bots.find(b => b.id === id);
        if (bot) { bot.estado = 'apagado'; guardarBots(bots); }
        io.emit('bot_estado', { id, estado: 'apagado' });
    }
    res.json({ mensaje: 'Detenido' });
});

// Reiniciar bot
app.post('/api/bots/:id/restart', async (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; await new Promise(r => setTimeout(r, 1000)); }
    // Redirigir a start
    const startRes = await fetch(`http://localhost:${PORT}/api/bots/${id}/start`, { method: 'POST' });
    res.json({ mensaje: 'Reiniciado' });
});

// Eliminar bot
app.delete('/api/bots/:id', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot && fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
    guardarBots(bots.filter(b => b.id !== id));
    io.emit('bot_eliminado', id);
    res.json({ mensaje: 'Eliminado' });
});

// Listar archivos del bot
app.get('/api/bots/:id/files', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot || !fs.existsSync(bot.carpeta)) return res.json([]);
    
    function listarArchivos(dir, base = '') {
        let results = [];
        const items = fs.readdirSync(dir);
        items.forEach(item => {
            const fullPath = path.join(dir, item);
            const relative = path.join(base, item);
            if (fs.statSync(fullPath).isDirectory()) {
                results = results.concat(listarArchivos(fullPath, relative));
            } else {
                results.push({ nombre: relative, tamano: fs.statSync(fullPath).size });
            }
        });
        return results;
    }
    res.json(listarArchivos(bot.carpeta));
});

// Subir archivo al bot
app.post('/api/bots/:id/upload', upload.single('archivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });
    res.json({ mensaje: 'Archivo subido', nombre: req.file.originalname });
});

// Limpiar consola
app.post('/api/bots/:id/clearconsole', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot) { bot.logs = []; guardarBots(bots); }
    io.emit('console_cleared', id);
    res.json({ mensaje: 'Consola limpiada' });
});

// Ruta principal
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== WEBSOCKET =====
io.on('connection', socket => {
    console.log('🟢 Conectado');
    socket.emit('bots_list', cargarBots());
});

// ===== INICIAR =====
server.listen(PORT, () => {
    console.log(`🚀 Panel corriendo en puerto ${PORT}`);
});
