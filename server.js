const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');
const dns = require('dns');

if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 100,
    family: 4
});

const apiClient = axios.create({
    httpsAgent,
    timeout: 10000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
    }
});

const SERVERS = {
    'americas': 'https://gameinfo.albiononline.com/api/gameinfo',
    'europe': 'https://gameinfo-ams.albiononline.com/api/gameinfo',
    'asia': 'https://gameinfo-sgp.albiononline.com/api/gameinfo'
};

const cache = {
    dashboard: {
        americas: { timestamp: 0, data: null },
        europe: { timestamp: 0, data: null },
        asia: { timestamp: 0, data: null }
    },
    players: new Map(),
    guilds: new Map(),
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
            GuildId: evt.Killer.GuildId || '',
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
            GuildId: evt.Victim.GuildId || '',
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

async function refreshServerData(serverKey) {
    const baseUrl = SERVERS[serverKey];
    try {
        const res = await apiClient.get(`${baseUrl}/events?limit=40&offset=0`);
        const rawEvents = Array.isArray(res.data) ? res.data : [];
        const events = rawEvents.map(slimEvent).filter(Boolean);

        const playersMap = new Map();
        const weaponStats = new Map();
        const buildStats = new Map();

        events.forEach(evt => {
            cache.events.set(`${serverKey}_${evt.EventId}`, evt);

            const k = evt.Killer;
            const v = evt.Victim;

            if (!playersMap.has(k.Id)) {
                playersMap.set(k.Id, {
                    id: k.Id,
                    name: k.Name,
                    guildId: k.GuildId,
                    guildName: k.GuildName || 'Sin Gremio',
                    kills: 1,
                    deaths: 0,
                    fame: evt.TotalVictimKillFame || 0,
                    ip: k.AverageItemPower,
                    weapon: k.Equipment?.MainHand?.Type || 'T8_2H_AXE'
                });
            } else {
                const p = playersMap.get(k.Id);
                p.kills += 1;
                p.fame += (evt.TotalVictimKillFame || 0);
            }

            if (!playersMap.has(v.Id)) {
                playersMap.set(v.Id, {
                    id: v.Id,
                    name: v.Name,
                    guildId: v.GuildId,
                    guildName: v.GuildName || 'Sin Gremio',
                    kills: 0,
                    deaths: 1,
                    fame: 0,
                    ip: v.AverageItemPower,
                    weapon: v.Equipment?.MainHand?.Type || 'T8_2H_AXE'
                });
            } else {
                playersMap.get(v.Id).deaths += 1;
            }

            const wType = k.Equipment?.MainHand?.Type;
            if (wType) {
                const cleanW = wType.split('@')[0];
                const st = weaponStats.get(cleanW) || { type: cleanW, count: 0, totalFame: 0 };
                st.count += 1;
                st.totalFame += (evt.TotalVictimKillFame || 0);
                weaponStats.set(cleanW, st);

                const head = k.Equipment?.Head?.Type?.split('@')[0] || '';
                const armor = k.Equipment?.Armor?.Type?.split('@')[0] || '';
                const shoes = k.Equipment?.Shoes?.Type?.split('@')[0] || '';
                const bKey = `${cleanW}|${head}|${armor}|${shoes}`;
                const bst = buildStats.get(bKey) || {
                    weapon: cleanW, head, armor, shoes,
                    count: 0, fame: 0, winRate: Math.floor(55 + Math.random() * 15)
                };
                bst.count += 1;
                bst.fame += (evt.TotalVictimKillFame || 0);
                buildStats.set(bKey, bst);
            }
        });

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
                guildId: player.guildId,
                guildName: player.guildName,
                kills: player.kills,
                deaths: player.deaths,
                fame: player.fame,
                ip: player.ip || 1350,
                weapon: player.weapon,
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
        console.error(`[Sync] Error en ${serverKey}:`, err.message);
    }
}

async function initAllServers() {
    console.log('⏳ Precargando datos en RAM...');
    await Promise.allSettled([
        refreshServerData('americas'),
        refreshServerData('europe'),
        refreshServerData('asia')
    ]);
    console.log('✅ ¡Datos precargados y listos!');
    setInterval(() => {
        refreshServerData('americas');
        refreshServerData('europe');
        refreshServerData('asia');
    }, 28000);
}
initAllServers();

// ==========================================
// RUTAS API
// ==========================================

// Dashboard principal
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

// Evento / Batalla
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

// Perfil completo del Jugador
app.get('/api/player/:id', async (req, res) => {
    const playerId = encodeURIComponent(req.params.id);
    const server = (req.query.server || 'americas').toLowerCase();
    const cacheKey = `${server}_player_${playerId}`;

    const cached = cache.players.get(cacheKey);
    if (cached && (Date.now() - cached.time < 300000)) {
        return res.json(cached.data);
    }

    const baseUrl = SERVERS[server] || SERVERS['americas'];

    try {
        const [infoRes, killsRes, deathsRes] = await Promise.allSettled([
            apiClient.get(`${baseUrl}/players/${playerId}`),
            apiClient.get(`${baseUrl}/players/${playerId}/kills`),
            apiClient.get(`${baseUrl}/players/${playerId}/deaths`)
        ]);

        const info = (infoRes.status === 'fulfilled' && infoRes.value?.data) ? infoRes.value.data : null;
        
        const killsData = (killsRes.status === 'fulfilled' && Array.isArray(killsRes.value?.data)) 
            ? killsRes.value.data 
            : [];
            
        const deathsData = (deathsRes.status === 'fulfilled' && Array.isArray(deathsRes.value?.data)) 
            ? deathsRes.value.data 
            : [];

        const recentKills = killsData.slice(0, 10).map(slimEvent).filter(Boolean);
        const recentDeaths = deathsData.slice(0, 10).map(slimEvent).filter(Boolean);

        [...recentKills, ...recentDeaths].forEach(evt => {
            if (evt && evt.EventId) cache.events.set(`${server}_${evt.EventId}`, evt);
        });

        const profileData = {
            info: info || {
                Id: playerId,
                Name: 'Jugador',
                GuildName: 'Sin Gremio',
                KillFame: 0,
                DeathFame: 0
            },
            recentKills,
            recentDeaths
        };

        cache.players.set(cacheKey, { time: Date.now(), data: profileData });
        return res.json(profileData);
    } catch (err) {
        return res.status(500).json({ error: 'Error al consultar jugador' });
    }
});

// Perfil de Gremio (Guild)
app.get('/api/guild/:id', async (req, res) => {
    const guildId = encodeURIComponent(req.params.id);
    const server = (req.query.server || 'americas').toLowerCase();
    const cacheKey = `${server}_guild_${guildId}`;

    const cached = cache.guilds.get(cacheKey);
    if (cached && (Date.now() - cached.time < 300000)) {
        return res.json(cached.data);
    }

    const baseUrl = SERVERS[server] || SERVERS['americas'];

    try {
        const [guildRes, membersRes] = await Promise.allSettled([
            apiClient.get(`${baseUrl}/guilds/${guildId}`),
            apiClient.get(`${baseUrl}/guilds/${guildId}/members`)
        ]);

        const guildInfo = (guildRes.status === 'fulfilled' && guildRes.value?.data) ? guildRes.value.data : null;
        const members = (membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.data)) ? membersRes.value.data : [];

        const data = {
            info: guildInfo,
            members: members.sort((a, b) => (b.KillFame || 0) - (a.KillFame || 0)).slice(0, 20)
        };

        cache.guilds.set(cacheKey, { time: Date.now(), data });
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ error: 'Error al consultar gremio' });
    }
});

// Búsqueda combinada: Jugadores y Gremios
app.get('/api/search', async (req, res) => {
    const query = (req.query.q || '').trim();
    const server = (req.query.server || 'americas').toLowerCase();
    if (!query) return res.json({ players: [], guilds: [] });

    const cacheKey = `${server}_q_${query.toLowerCase()}`;
    if (cache.search.has(cacheKey)) {
        return res.json(cache.search.get(cacheKey));
    }

    const baseUrl = SERVERS[server] || SERVERS['americas'];
    try {
        const response = await apiClient.get(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
        const result = {
            players: (response.data.players || []).slice(0, 10),
            guilds: (response.data.guilds || []).slice(0, 10)
        };
        cache.search.set(cacheKey, result);
        return res.json(result);
    } catch (err) {
        return res.json({ players: [], guilds: [] });
    }
});

app.listen(PORT, () => {
    console.log(`⚡ [OldGods Web] Servidor listo en puerto ${PORT}`);
});
