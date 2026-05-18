const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_FILE = path.join(DATA_DIR, 'images.json');

// Crear carpetas
[DATA_DIR, UPLOADS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(IMAGES_FILE)) fs.writeFileSync(IMAGES_FILE, JSON.stringify([], null, 2));

// Configurar multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4().substring(0, 8) + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            // Imágenes
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
            // Videos
            '.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.3gp'
        ];
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext));
    }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

// ===== FUNCIONES =====
function cargarArchivos() {
    return JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8'));
}

function guardarArchivos(data) {
    fs.writeFileSync(IMAGES_FILE, JSON.stringify(data, null, 2));
}

// ===== API =====

// Obtener todos los archivos
app.get('/api/files', (req, res) => {
    const files = cargarArchivos();
    res.json(files);
});

// Subir archivo
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se subió archivo o formato no permitido' });
    }

    const nuevoArchivo = {
        id: uuidv4().substring(0, 8),
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        type: req.file.mimetype,
        url: '/uploads/' + req.file.filename,
        fecha: new Date().toISOString(),
        expira: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() // 60 días
    };

    const files = cargarArchivos();
    files.push(nuevoArchivo);
    guardarArchivos(files);

    res.json(nuevoArchivo);
});

// Eliminar archivo
app.delete('/api/files/:id', (req, res) => {
    const { id } = req.params;
    let files = cargarArchivos();
    const file = files.find(f => f.id === id);

    if (file) {
        const filePath = path.join(UPLOADS_DIR, file.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        files = files.filter(f => f.id !== id);
        guardarArchivos(files);
        res.json({ mensaje: 'Eliminado' });
    } else {
        res.status(404).json({ error: 'No encontrado' });
    }
});

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== LIMPIEZA AUTOMÁTICA CADA 24 HORAS =====
cron.schedule('0 0 * * *', () => {
    console.log('🧹 Limpiando archivos expirados...');
    const files = cargarArchivos();
    const ahora = new Date();
    const activos = files.filter(f => {
        const expira = new Date(f.expira);
        if (ahora > expira) {
            const filePath = path.join(UPLOADS_DIR, f.filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            console.log(`🗑️ Eliminado: ${f.originalname}`);
            return false;
        }
        return true;
    });
    guardarArchivos(activos);
    console.log(`✅ Limpieza completada. ${activos.length} archivos activos.`);
});

// ===== INICIAR =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🖼️ Saki Images corriendo en puerto ${PORT}`);
    console.log(`📁 Límite: 100 MB | Formatos: Imágenes + Videos | Duración: 60 días`);
});
