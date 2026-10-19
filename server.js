const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Selector de servidores de Albion
const SERVERS = {
    gameinfo: 'https://gameinfo.albiononline.com/api/gameinfo',
    ams: 'https://gameinfo-ams.albiononline.com/api/gameinfo',
    sgp: 'https://gameinfo-sgp.albiononline.com/api/gameinfo'
};

// 1. Endpoint: Buscar jugadores y clanes
app.get('/api/search', async (req, res) => {
    const { q, region = 'gameinfo' } = req.query;
    try {
        const url = `${SERVERS[region] || SERVERS.gameinfo}/search?q=${encodeURIComponent(q)}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: 'Error al buscar en Albion' });
    }
});

// 2. Endpoint: Kills Recientes Globales
app.get('/api/events', async (req, res) => {
    const { region = 'gameinfo', limit = 20 } = req.query;
    try {
        const url = `${SERVERS[region] || SERVERS.gameinfo}/events?limit=${limit}&offset=0`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: 'Error al obtener eventos' });
    }
});

// 3. Endpoint: Datos de un Jugador
app.get('/api/player/:id', async (req, res) => {
    const { id } = req.params;
    const { region = 'gameinfo' } = req.query;
    try {
        const url = `${SERVERS[region] || SERVERS.gameinfo}/players/${id}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: 'Jugador no encontrado' });
    }
});

app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`🌐 [OLDGODS KILLBOARD WEB]`);
    console.log(`👉 Abre tu navegador en: http://localhost:${PORT}`);
    console.log(`===============================================`);
});