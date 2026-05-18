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
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext));
    }
});

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

// ===== FUNCIONES =====
function cargarImagenes() {
    return JSON.parse(fs.readFileSync(IMAGES_FILE, 'utf-8'));
}
function guardarImagenes(data) {
    fs.writeFileSync(IMAGES_FILE, JSON.stringify(data, null, 2));
}

// ===== API =====
app.get('/api/images', (req, res) => {
    const images = cargarImagenes();
    res.json(images);
});

app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió imagen o formato no permitido' });
    
    const nuevaImagen = {
        id: uuidv4().substring(0, 8),
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        url: '/uploads/' + req.file.filename,
        fecha: new Date().toISOString(),
        expira: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() // 60 días
    };
    
    const images = cargarImagenes();
    images.push(nuevaImagen);
    guardarImagenes(images);
    
    res.json(nuevaImagen);
});

app.delete('/api/images/:id', (req, res) => {
    const { id } = req.params;
    let images = cargarImagenes();
    const img = images.find(i => i.id === id);
    if (img) {
        const filePath = path.join(UPLOADS_DIR, img.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        images = images.filter(i => i.id !== id);
        guardarImagenes(images);
        res.json({ mensaje: 'Eliminada' });
    } else {
        res.status(404).json({ error: 'No encontrada' });
    }
});

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== LIMPIEZA AUTOMÁTICA CADA 24 HORAS =====
cron.schedule('0 0 * * *', () => {
    console.log('🧹 Limpiando imágenes expiradas...');
    const images = cargarImagenes();
    const ahora = new Date();
    const activas = images.filter(img => {
        const expira = new Date(img.expira);
        if (ahora > expira) {
            const filePath = path.join(UPLOADS_DIR, img.filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return false;
        }
        return true;
    });
    guardarImagenes(activas);
    console.log(`✅ ${images.length - activas.length} imágenes eliminadas`);
});

// ===== INICIAR =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🖼️ Saki Images corriendo en puerto ${PORT}`);
});
