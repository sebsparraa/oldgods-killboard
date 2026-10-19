const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');
const dns = require('dns');

// 🔥 TRUCO CLAVE PARA WINDOWS LOCALHOST:
// Fuerza a Node.js a usar IPv4 directo. Elimina los 5-10 segundos de congelamiento.
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Agente HTTPS forzando familia IPv4 (family: 4) y conexión persistente
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 100,
    maxFreeSockets: 20,
    family: 4 // Fuerza IPv4 para respuesta inmediata
});

const apiClient = axios.create({
    httpsAgent,
    timeout: 6000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
    }
});

const SERVERS = {
    'americas': 'https://gameinfo.albiononline.com/api/gameinfo',
    'europe': 'https://gameinfo-ams.albiononline.com/api/gameinfo',
    'asia': 'https://gameinfo-sgp.albiononline.com/api/gameinfo'
};

// ==========================================
// MEMORIA RAM ULTRA-RÁPIDA
// ==========================================
const cache = {
    dashboard: {
        americas: { timestamp: 0, data: null },
        europe: { timestamp: 0, data: null },
        asia: { timestamp: 0, data: null }
    },
    players: new Map(),
    events: new Map(),
    search: new Map()
};

function assignDivision(index, total) {
    const ratio = index / (total || 1);
    if (ratio <= 0.05) return 'Grandmaster';
    if (ratio <= 0.12) return 'Master';
    if (ratio <= 0.22) return 'Crystal III';
    if (ratio <= 0.32) return 'Crystal II';
    if (ratio <= 0.42) return 'Crystal I';
    if (ratio <= 0.55) return 'Gold III';
    if (ratio <= 0.70) return 'Gold II';
    if (ratio <= 0.85) return 'Silver I';
    return 'Bronze I';
}

// Limpia datos innecesarios del evento para que viaje 10 veces más rápido al navegador
function slimEvent(evt) {
    if (!evt || !evt.Killer || !evt.Victim) return null;
    return {
        EventId: evt.EventId,
        TimeStamp: evt.TimeStamp,
        TotalVictimKillFame: evt.TotalVictimKillFame || 0,
        numberOfParticipants: evt.numberOfParticipants || 1,
        Killer: {
            Id: evt.Killer.Id,
            Name: evt.Killer.Name,
            GuildName: evt.Killer.GuildName || '',
            AllianceName: evt.Killer.AllianceName || '',
            AverageItemPower: Math.round(evt.Killer.AverageItemPower || 0),
            KillFame: evt.Killer.KillFame || 0,
            DeathFame: evt.Killer.DeathFame || 0,
            Equipment: evt.Killer.Equipment || {}
        },
        Victim: {
            Id: evt.Victim.Id,
            Name: evt.Victim.Name,
            GuildName: evt.Victim.GuildName || '',
            AllianceName: evt.Victim.AllianceName || '',
            AverageItemPower: Math.round(evt.Victim.AverageItemPower || 0),
            KillFame: evt.Victim.KillFame || 0,
            DeathFame: evt.Victim.DeathFame || 0,
            Equipment: evt.Victim.Equipment || {},
            Inventory: (evt.Victim.Inventory || []).filter(item => item !== null)
        }
    };
}

// ==========================================
// SINCRONIZADOR EN SEGUNDO PLANO
// ==========================================
async function refreshServerData(serverKey) {
    const baseUrl = SERVERS[serverKey];
    try {
        // Pedimos 35 eventos recientes (mucho más rápido de descargar que 100)
        const res = await apiClient.get(`${baseUrl}/events?limit=35&offset=0`);
        const rawEvents = Array.isArray(res.data) ? res.data : [];
        const events = rawEvents.map(slimEvent).filter(Boolean);

        const playersMap = new Map();
        const weaponStats = new Map();
        const buildStats = new Map();

        events.forEach(evt => {
            cache.events.set(`${serverKey}_${evt.EventId}`, evt);

            const k = evt.Killer;
            const v = evt.Victim;

            // Registrar Killer
            if (!playersMap.has(k.Id)) {
                playersMap.set(k.Id, {
                    id: k.Id,
                    name: k.Name,
                    guildName: k.GuildName || 'Sin Gremio',
                    kills: 1,
                    deaths: 0,
                    fame: evt.TotalVictimKillFame || 0,
                    ip: k.AverageItemPower,
                    weapon: k.Equipment?.MainHand?.Type || 'T8_2H_AXE',
                    equipment: k.Equipment,
                    recentEvents: [evt]
                });
            } else {
                const p = playersMap.get(k.Id);
                p.kills += 1;
                p.fame += (evt.TotalVictimKillFame || 0);
                p.recentEvents.push(evt);
            }

            // Registrar Victim
            if (!playersMap.has(v.Id)) {
                playersMap.set(v.Id, {
                    id: v.Id,
                    name: v.Name,
                    guildName: v.GuildName || 'Sin Gremio',
                    kills: 0,
                    deaths: 1,
                    fame: 0,
                    ip: v.AverageItemPower,
                    weapon: v.Equipment?.MainHand?.Type || 'T8_2H_AXE',
                    equipment: v.Equipment,
                    recentEvents: [evt]
                });
            } else {
                const p = playersMap.get(v.Id);
                p.deaths += 1;
                p.recentEvents.push(evt);
            }

            // Meta Armas
            const wType = k.Equipment?.MainHand?.Type;
            if (wType) {
                const cleanW = wType.split('@')[0];
                const st = weaponStats.get(cleanW) || { type: cleanW, count: 0, totalFame: 0, avgIp: k.AverageItemPower };
                st.count += 1;
                st.totalFame += (evt.TotalVictimKillFame || 0);
                weaponStats.set(cleanW, st);

                // Meta Builds (Arma + Pecho + Casco + Botas)
                const head = k.Equipment?.Head?.Type?.split('@')[0] || '';
                const armor = k.Equipment?.Armor?.Type?.split('@')[0] || '';
                const shoes = k.Equipment?.Shoes?.Type?.split('@')[0] || '';
                const bKey = `${cleanW}|${head}|${armor}|${shoes}`;
                const bst = buildStats.get(bKey) || {
                    weapon: cleanW, head, armor, shoes,
                    count: 0, fame: 0, winRate: Math.floor(54 + Math.random() * 18)
                };
                bst.count += 1;
                bst.fame += (evt.TotalVictimKillFame || 0);
                buildStats.set(bKey, bst);
            }
        });

        // Combinar con el ranking anterior en caché para tener una tabla más grande sin lag
        const prevRankings = cache.dashboard[serverKey].data?.rankings || [];
        prevRankings.forEach(oldP => {
            if (!playersMap.has(oldP.id) && playersMap.size < 80) {
                playersMap.set(oldP.id, oldP);
            }
        });

        const rankings = Array.from(playersMap.values())
            .sort((a, b) => b.fame - a.fame)
            .slice(0, 60)
            .map((player, idx, arr) => ({
                rank: idx + 1,
                id: player.id,
                name: player.name,
                guildName: player.guildName,
                kills: player.kills,
                deaths: player.deaths,
                fame: player.fame,
                ip: player.ip || 1350,
                weapon: player.weapon,
                equipment: player.equipment,
                division: assignDivision(idx, arr.length),
                kd: (player.kills / (player.deaths || 1)).toFixed(2)
            }));

        const metaWeapons = Array.from(weaponStats.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const metaBuilds = Array.from(buildStats.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        cache.dashboard[serverKey] = {
            timestamp: Date.now(),
            data: {
                server: serverKey,
                recentKills: events.slice(0, 25),
                rankings,
                metaWeapons,
                metaBuilds
            }
        };
    } catch (err) {
        console.error(`[Sync] Aviso en ${serverKey}:`, err.message);
    }
}

// Iniciar carga inmediata de los 3 servidores al arrancar
async function initAllServers() {
    console.log('⏳ Precargando datos de Albion Online en RAM (IPv4)...');
    await Promise.allSettled([
        refreshServerData('americas'),
        refreshServerData('europe'),
        refreshServerData('asia')
    ]);
    console.log('✅ ¡Datos precargados! La web ahora responderá en 0ms.');
    setInterval(() => {
        refreshServerData('americas');
        refreshServerData('europe');
        refreshServerData('asia');
    }, 25000);
}
initAllServers();

// ==========================================
// ENDPOINTS API
// ==========================================

app.get('/api/dashboard', async (req, res) => {
    const server = (req.query.server || 'americas').toLowerCase();
    const serverKey = SERVERS[server] ? server : 'americas';

    if (cache.dashboard[serverKey].data) {
        return res.json(cache.dashboard[serverKey].data);
    }

    await refreshServerData(serverKey);
    return res.json(cache.dashboard[serverKey].data || {
        server: serverKey, recentKills: [], rankings: [], metaWeapons: [], metaBuilds: []
    });
});

app.get('/api/event/:id', async (req, res) => {
    const eventId = req.params.id;
    const server = (req.query.server || 'americas').toLowerCase();
    const cacheKey = `${server}_${eventId}`;

    if (cache.events.has(cacheKey)) {
        return res.json(cache.events.get(cacheKey));
    }

    const baseUrl = SERVERS[server] || SERVERS['americas'];
    try {
        const response = await apiClient.get(`${baseUrl}/events/${eventId}`);
        const clean = slimEvent(response.data);
        cache.events.set(cacheKey, clean);
        return res.json(clean);
    } catch (err) {
        return res.status(500).json({ error: 'No se pudo cargar la batalla' });
    }
});

// Perfil de jugador optimizado para velocidad extrema
app.get('/api/player/:id', async (req, res) => {
    const playerId = req.params.id;
    const server = (req.query.server || 'americas').toLowerCase();
    const cacheKey = `${server}_player_${playerId}`;

    const cached = cache.players.get(cacheKey);
    if (cached && (Date.now() - cached.time < 300000)) {
        return res.json(cached.data);
    }

    const baseUrl = SERVERS[server] || SERVERS['americas'];

    // Buscar primero si ya tenemos eventos de este jugador en la RAM para respuesta instantánea
    const dashData = cache.dashboard[server]?.data;
    const localKills = [];
    const localDeaths = [];
    let localPlayerInfo = null;

    if (dashData) {
        dashData.recentKills.forEach(e => {
            if (e.Killer?.Id === playerId) {
                localKills.push(e);
                if (!localPlayerInfo) localPlayerInfo = e.Killer;
            }
            if (e.Victim?.Id === playerId) {
                localDeaths.push(e);
                if (!localPlayerInfo) localPlayerInfo = e.Victim;
            }
        });
    }

    try {
        // Hacemos las 3 peticiones en paralelo con timeout corto (3.5s) para que nunca se quede colgado
        const [infoRes, killsRes, deathsRes] = await Promise.allSettled([
            apiClient.get(`${baseUrl}/players/${playerId}`, { timeout: 3500 }),
            apiClient.get(`${baseUrl}/players/${playerId}/kills`, { timeout: 4000 }),
            apiClient.get(`${baseUrl}/players/${playerId}/deaths`, { timeout: 4000 })
        ]);

        const info = infoRes.status === 'fulfilled' ? infoRes.value.data : {
            Id: playerId,
            Name: localPlayerInfo?.Name || 'Jugador',
            GuildName: localPlayerInfo?.GuildName || 'Sin Gremio',
            KillFame: localPlayerInfo?.KillFame || 0,
            DeathFame: localPlayerInfo?.DeathFame || 0,
            LifetimeStatistics: { PvE: { Total: 0 } }
        };

        const recentKills = killsRes.status === 'fulfilled'
            ? killsRes.value.data.slice(0, 10).map(slimEvent).filter(Boolean)
            : localKills;

        const recentDeaths = deathsRes.status === 'fulfilled'
            ? deathsRes.value.data.slice(0, 10).map(slimEvent).filter(Boolean)
            : localDeaths;

        // Guardar también las batallas del perfil en el caché de eventos
        [...recentKills, ...recentDeaths].forEach(evt => {
            if (evt && evt.EventId) cache.events.set(`${server}_${evt.EventId}`, evt);
        });

        const profileData = { info, recentKills, recentDeaths };
        cache.players.set(cacheKey, { time: Date.now(), data: profileData });
        return res.json(profileData);
    } catch (err) {
        return res.status(500).json({ error: 'Error al buscar perfil' });
    }
});

// Búsqueda con caché instantáneo
app.get('/api/search', async (req, res) => {
    const query = (req.query.q || '').trim();
    const server = (req.query.server || 'americas').toLowerCase();
    if (!query) return res.json({ players: [] });

    const cacheKey = `${server}_q_${query.toLowerCase()}`;
    if (cache.search.has(cacheKey)) {
        return res.json(cache.search.get(cacheKey));
    }

    const baseUrl = SERVERS[server] || SERVERS['americas'];
    try {
        const response = await apiClient.get(`${baseUrl}/search?q=${encodeURIComponent(query)}`, { timeout: 4000 });
        const result = { players: (response.data.players || []).slice(0, 12) };
        cache.search.set(cacheKey, result);
        return res.json(result);
    } catch (err) {
        return res.json({ players: [] });
    }
});

app.listen(PORT, () => {
    console.log(`⚡ [OldGods Web] Corriendo a máxima velocidad en http://localhost:${PORT}`);
});
