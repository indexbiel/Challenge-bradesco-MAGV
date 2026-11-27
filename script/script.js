const segmentos = [
    ["Borda do Internet Banking", 420],
    ["Gateway de pagamentos", 780],
    ["Autenticação e biometria", 260],
    ["Gateway mobile", 610]
].map(([nome, base]) => ({ nome, base, trafego: base, anomalia: 4, queda: 0, pico: 0, status: "ok" }));

const servicos = [
    ["Pix", "Pagamento instantâneo", 1, 140, 420],
    ["Transferência TED/DOC", "Transferências", 1, 220, 180],
    ["Geração de boleto", "Cobrança", 1, 260, 150],
    ["Autenticação", "Login e token", 2, 90, 610],
    ["Reconhecimento facial", "Biometria", 2, 300, 95],
    ["Consulta de saldo", "Conta corrente", 3, 110, 540],
    ["Cartões", "Limite e fatura", 3, 190, 230],
    ["Portal / Internet Banking", "Site", 0, 170, 700]
].map(([nome, descricao, segmento, base, requisicoes]) => ({
    nome, descricao, segmento, base, requisicoes, latencia: base, erros: 0, queda: 0, pico: 0, status: "ok"
}));

const perfis = {
    analista: { nome: "Analista SRE", sigla: "AN", descricao: "Acompanha o painel e aprova ações de risco médio", aprova: ["medio"] },
    gestor: { nome: "Gestor", sigla: "GE", descricao: "Aprova ações de risco médio e alto", aprova: ["medio", "alto"] },
    auditor: { nome: "Auditor", sigla: "AU", descricao: "Somente consulta incidentes e auditoria", aprova: [] }
};

const limitePontos = 30;
const limiteLento = 450;
const limiteCritico = 800;
const limiteAnomaliaAlerta = 20;
const limiteAtaque = 30;
const limiteAnomaliaCritico = 40;
const maximoAbertos = 3;
const intervaloMinimo = 20000;

const historicoApi = { media: [], pior: [] };
const historicoRede = { media: [], pior: [] };
const textoStatus = { ok: "Operacional", warn: "Lento", crit: "Crítico" };
const textoStatusRede = { ok: "Normal", warn: "Atenção", crit: "Anômalo" };
const cores = { ok: "#1b8a4b", warn: "#c77700", crit: "#cc092f" };
const textoRisco = { baixo: "Risco baixo", medio: "Risco médio", alto: "Risco alto" };
const classeRisco = { baixo: "t-ok", medio: "t-warn", alto: "t-crit" };

let incidentes = [];
let auditoria = [];
let contador = 0;
let perfilAtual = "analista";
let pausado = false;
let aquecendo = false;
let ultimoIncidente = 0;
let forcarAte = 0;

const $ = (id) => document.getElementById(id);
const aleatorio = (min, max) => min + Math.random() * (max - min);
const formatar = (n) => n.toFixed(1).replace(".", ",");
const media = (lista, campo) => lista.reduce((soma, x) => soma + x[campo], 0) / lista.length;
const maximo = (lista, campo) => Math.max(...lista.map((x) => x[campo]));
const statusPor = (valor, alerta, critico) => (valor >= critico ? "crit" : valor >= alerta ? "warn" : "ok");
const estaAberto = (inc) => inc.estado === "aguardando" || inc.estado === "executando";
const temIncidente = (campo, indice) => incidentes.some((inc) => estaAberto(inc) && inc[campo] === indice);
const podeAprovar = (inc) => perfis[perfilAtual].aprova.includes(inc.risco);

function iniciarQueda(s) {
    s.queda = Math.floor(aleatorio(5, 12));
    s.pico = aleatorio(900, 2600);
}

function atualizarServico(s) {
    if (s.queda > 0) {
        s.queda--;
        s.latencia += (s.pico - s.latencia) * 0.45 + aleatorio(-80, 80);
        s.erros = Math.min(35, s.erros + aleatorio(2, 6));
    } else {
        if (Math.random() < 0.003) iniciarQueda(s);
        s.latencia += (s.base - s.latencia) * 0.35 + aleatorio(-s.base * 0.12, s.base * 0.15);
        if (Math.random() < 0.004) s.latencia += aleatorio(s.base * 0.8, s.base * 2.2);
        s.erros = Math.max(0, s.erros - aleatorio(1, 3));
    }
    s.latencia = Math.max(35, s.latencia);
}

function atualizarSegmento(s) {
    if (s.queda > 0) {
        s.queda--;
        s.anomalia += (s.pico - s.anomalia) * 0.5 + aleatorio(-3, 3);
        s.trafego += (s.base * 2.4 - s.trafego) * 0.4;
    } else {
        if (Math.random() < 0.0015) {
            s.queda = Math.floor(aleatorio(4, 7));
            s.pico = aleatorio(42, 55);
        }
        s.anomalia += (4 - s.anomalia) * 0.35 + aleatorio(-2, 3);
        s.trafego += (s.base - s.trafego) * 0.3 + aleatorio(-s.base * 0.05, s.base * 0.05);
    }
    s.anomalia = Math.min(100, Math.max(0.5, s.anomalia));
}

function classificarRisco(anomalia, status) {
    const ataque = anomalia >= limiteAtaque;

    if (ataque && status === "crit") return { tipo: "Suspeita de ataque", risco: "alto", acao: "Bloquear origens suspeitas e limitar a taxa da API" };
    if (ataque) return { tipo: "Suspeita de ataque", risco: "medio", acao: "Limitar a taxa de requisições da API" };
    if (status === "crit") return { tipo: "Falha técnica", risco: "medio", acao: "Reiniciar a instância e redirecionar o tráfego" };
    return { tipo: "Falha técnica", risco: "baixo", acao: "Escalar instâncias da API" };
}

function carregarAuditoria() {
    try {
        auditoria = JSON.parse(localStorage.getItem("sentinela_auditoria")) || [];
    } catch (erro) {
        auditoria = [];
    }

    auditoria.forEach((a) => {
        if (["Em execução", "Aguardando", "Em análise"].includes(a.resultado)) a.resultado = "Interrompido (sessão encerrada)";
    });
    contador = auditoria.length;
}

function atualizarAuditoria(inc, campos) {
    Object.assign(auditoria.find((a) => a.id === inc.id), campos);
    try {
        localStorage.setItem("sentinela_auditoria", JSON.stringify(auditoria));
    } catch (erro) {
    }
    renderAuditoria();
}

function podeCriarIncidente() {
    if (aquecendo) return false;
    if (Date.now() < forcarAte) return true;
    return incidentes.filter(estaAberto).length < maximoAbertos && Date.now() - ultimoIncidente >= intervaloMinimo;
}

function criarIncidente(classe, local, segmento, servico, explicacao) {
    if (!podeCriarIncidente()) return;

    ultimoIncidente = Date.now();
    const inc = {
        id: "INC-" + String(++contador).padStart(3, "0"),
        ...classe, local, segmento, servico, explicacao,
        etapa: 2, estado: "aguardando", autorizacao: "Pendente",
        criadoEm: Date.now(), resolvidoEm: 0, hora: new Date().toLocaleTimeString("pt-BR")
    };

    incidentes.unshift(inc);
    incidentes.length = Math.min(incidentes.length, 30);
    auditoria.unshift({
        id: inc.id,
        hora: new Date().toLocaleString("pt-BR"),
        evento: `${inc.tipo} em ${local}`,
        decisao: `Classificado como ${textoRisco[inc.risco].toLowerCase()}`,
        autorizacao: "—",
        resultado: "Em análise"
    });
    decidir(inc);
}

function criarIncidenteServico(i) {
    const s = servicos[i];
    const seg = segmentos[s.segmento];
    const classe = classificarRisco(seg.anomalia, s.status);
    const explicacao = classe.tipo === "Suspeita de ataque"
        ? `Latência de ${Math.round(s.latencia)} ms em ${s.nome} junto de ${formatar(seg.anomalia)}% de acessos fora do padrão em ${seg.nome}. Sinais de rede e de API apontam para ataque.`
        : `Latência de ${Math.round(s.latencia)} ms e ${formatar(s.erros)}% de erros em ${s.nome}. A rede em ${seg.nome} está normal (${formatar(seg.anomalia)}% fora do padrão): indica falha técnica.`;

    criarIncidente(classe, s.nome, s.segmento, i, explicacao);
}

function criarIncidenteRede(i) {
    const seg = segmentos[i];
    const classe = { tipo: "Anomalia de rede", risco: "medio", acao: "Aplicar filtro de acessos e acompanhar" };

    criarIncidente(classe, seg.nome, i, -1, `${formatar(seg.anomalia)}% de acessos fora do padrão em ${seg.nome}, ainda sem impacto nas APIs.`);
}

function decidir(inc) {
    inc.etapa = 3;

    if (inc.risco === "baixo") {
        inc.autorizacao = "Automática (regra de baixo risco)";
        inc.estado = "executando";
        atualizarAuditoria(inc, { decisao: "Executar automaticamente: " + inc.acao, autorizacao: inc.autorizacao, resultado: "Em execução" });
        setTimeout(() => executar(inc), 3000);
    } else {
        atualizarAuditoria(inc, { decisao: "Pedir aprovação humana: " + inc.acao, autorizacao: "Pendente", resultado: "Aguardando" });
    }
    renderTudo();
}

function executar(inc) {
    inc.etapa = 4;
    inc.estado = "resolvido";
    inc.resolvidoEm = Date.now();

    if (inc.servico >= 0) {
        const s = servicos[inc.servico];
        s.queda = 0;
        s.latencia = s.base * 1.2;
        s.erros = 0;
    }
    segmentos[inc.segmento].queda = 0;

    atualizarAuditoria(inc, { resultado: "Ação simulada executada com sucesso" });
    renderTudo();
}

function responder(id, aprovado) {
    const inc = incidentes.find((i) => i.id === id);

    if (!inc || inc.estado !== "aguardando" || !podeAprovar(inc)) return;

    const quem = perfis[perfilAtual].nome;

    if (aprovado) {
        inc.autorizacao = "Aprovado por " + quem;
        inc.estado = "executando";
        atualizarAuditoria(inc, { autorizacao: inc.autorizacao, resultado: "Em execução" });
        setTimeout(() => executar(inc), 2000);
    } else {
        inc.autorizacao = "Rejeitado por " + quem;
        inc.estado = "rejeitado";
        inc.etapa = 4;
        atualizarAuditoria(inc, { autorizacao: inc.autorizacao, resultado: "Ação rejeitada; monitoramento mantido" });
    }
    renderTudo();
}

function manterIncidentesAbertos() {
    incidentes.filter((i) => i.estado === "aguardando").forEach((i) => {
        if (i.servico >= 0) servicos[i.servico].queda = Math.max(servicos[i.servico].queda, 2);
        if (i.tipo !== "Falha técnica") segmentos[i.segmento].queda = Math.max(segmentos[i.segmento].queda, 2);
    });
}

function verificarServico(s, i) {
    const novo = statusPor(s.latencia, limiteLento, limiteCritico);

    if (novo === s.status) return;
    s.status = novo;
    if (novo !== "ok" && !temIncidente("servico", i)) criarIncidenteServico(i);
}

function verificarSegmento(s, i) {
    const novo = statusPor(s.anomalia, limiteAnomaliaAlerta, limiteAnomaliaCritico);

    if (novo === s.status) return;
    s.status = novo;
    if (novo === "crit" && !temIncidente("segmento", i)) criarIncidenteRede(i);
}

function atualizarCards() {
    const abertos = incidentes.filter(estaAberto).length;
    const aguardando = incidentes.filter((i) => i.estado === "aguardando").length;
    const pior = segmentos.reduce((a, b) => (b.anomalia > a.anomalia ? b : a));

    $("sLat").textContent = Math.round(media(servicos, "latencia"));
    $("sLatSub").textContent = "Pior: " + Math.round(maximo(servicos, "latencia")) + " ms";
    $("sTrafego").textContent = Math.round(segmentos.reduce((soma, s) => soma + s.trafego, 0));
    $("sTrafegoSub").textContent = segmentos.length + " segmentos monitorados";
    $("sAnom").textContent = formatar(pior.anomalia);
    $("sAnomSub").textContent = "Maior: " + pior.nome;
    $("sAnom").parentElement.classList.toggle("bad", pior.anomalia >= limiteAtaque);
    $("sInc").textContent = abertos;
    $("sIncSub").textContent = abertos ? aguardando + " aguardando aprovação" : "Nenhum incidente aberto";
    $("sInc").parentElement.classList.toggle("bad", abertos > 0);
    $("badgeInc").textContent = abertos;
    $("badgeInc").hidden = abertos === 0;
}

const barra = (largura, cor) => `<div class='bar'><i style='width:${Math.min(100, largura)}%;background:${cor}'></i></div>`;
const tag = (status, texto) => `<span class='tag t-${status}'>${texto}</span>`;

function atualizarTabelas() {
    $("rows").innerHTML = servicos.map((s) => {
        const req = Math.round(s.requisicoes * (s.status === "crit" ? 0.6 : 1) + aleatorio(-15, 15));

        return `<tr><td><b>${s.nome}</b></td>
            <td>${Math.round(s.latencia)} ms${barra(s.latencia / 10, cores[s.status])}</td>
            <td>${req}</td><td>${formatar(s.erros)}%</td>
            <td>${tag(s.status, textoStatus[s.status])}</td></tr>`;
    }).join("");

    $("rowsRede").innerHTML = segmentos.map((s) => `<tr><td><b>${s.nome}</b></td>
        <td>${Math.round(s.trafego)} Mbps</td>
        <td>${formatar(s.anomalia)}%${barra(s.anomalia * 2, cores[s.status])}</td>
        <td>${tag(s.status, textoStatusRede[s.status])}</td></tr>`).join("");
}

function renderIncidentes() {
    if (incidentes.length === 0) {
        $("listaIncidentes").innerHTML = "<div class='panel vazio'>Nenhum incidente até agora. Use “Simular falha técnica” ou “Simular ataque” no Painel.</div>";
        return;
    }

    $("listaIncidentes").innerHTML = incidentes.map((inc) => {
        const etapas = ["Monitorar", "Identificar", "Decidir", "Agir"].map((nome, i) =>
            `<li class='${i < inc.etapa ? "feita" : i === inc.etapa ? "atual" : ""}'>${nome}</li>`).join("");
        const bloqueio = podeAprovar(inc) ? "" : " disabled title='Seu perfil não aprova este nível de risco'";
        let rodape = `<span><b>Rejeitado</b> · ${inc.autorizacao}</span>`;

        if (inc.estado === "aguardando") {
            rodape = `<div class='inc-botoes'>
                <button class='btn btn-peq' data-acao='aprovar' data-id='${inc.id}'${bloqueio}>Aprovar</button>
                <button class='btn btn-peq btn-cinza' data-acao='rejeitar' data-id='${inc.id}'${bloqueio}>Rejeitar</button></div>`;
        } else if (inc.estado === "executando") {
            rodape = `<span>Executando ação simulada… (${inc.autorizacao})</span>`;
        } else if (inc.estado === "resolvido") {
            rodape = `<span><b>Resolvido em ${Math.round((inc.resolvidoEm - inc.criadoEm) / 1000)} s</b> · ${inc.autorizacao}</span>`;
        }

        return `<article class='inc inc-${inc.risco}'>
            <div class='inc-topo'>
                <div><b>${inc.id} · ${inc.tipo}</b><small>${inc.local} • ${inc.hora}</small></div>
                <span class='tag ${classeRisco[inc.risco]}'>${textoRisco[inc.risco]}</span>
            </div>
            <p class='inc-exp'>${inc.explicacao}</p>
            <ol class='etapas'>${etapas}</ol>
            <div class='inc-acao'><span>Ação recomendada: <b>${inc.acao}</b></span>${rodape}</div>
        </article>`;
    }).join("");
}

function renderAuditoria() {
    $("linhasAuditoria").innerHTML = auditoria.length
        ? auditoria.map((a) => `<tr><td>${a.hora}</td><td><b>${a.id}</b></td><td>${a.evento}</td><td>${a.decisao}</td><td>${a.autorizacao}</td><td>${a.resultado}</td></tr>`).join("")
        : "<tr><td colspan='6' class='vazio'>Nenhum registro ainda.</td></tr>";
}

function renderAcesso() {
    $("linhasAcesso").innerHTML = Object.keys(perfis).map((chave) => {
        const p = perfis[chave];
        const sim = (risco) => (p.aprova.includes(risco) ? "Sim" : "Não");

        return `<tr class='${chave === perfilAtual ? "atual" : ""}'><td><b>${p.nome}</b></td><td>${p.descricao}</td><td>${sim("medio")}</td><td>${sim("alto")}</td></tr>`;
    }).join("");
}

function desenharGrafico(idCanvas, hist, limite, unidade, minimoTopo) {
    const canvas = $(idCanvas);
    const largura = canvas.clientWidth;
    const altura = canvas.clientHeight;

    if (largura === 0) return;

    const ctx = canvas.getContext("2d");
    const escala = window.devicePixelRatio || 1;

    canvas.width = largura * escala;
    canvas.height = altura * escala;
    ctx.scale(escala, escala);

    const esq = 50, dir = 10, cima = 10, baixo = 26;
    const areaL = largura - esq - dir;
    const areaA = altura - cima - baixo;
    const slot = areaL / limitePontos;
    const inicio = limitePontos - hist.pior.length;
    const topo = Math.max(minimoTopo, ...hist.pior.map((v) => v * 1.05));
    const x = (i) => esq + (i + inicio + 0.5) * slot;
    const y = (v) => cima + areaA - (v / topo) * areaA;

    ctx.font = "11px Segoe UI, sans-serif";
    ctx.fillStyle = "#5c5256";
    ctx.strokeStyle = "#d3cacd";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const v = (topo / 4) * i;
        ctx.beginPath();
        ctx.moveTo(esq, y(v));
        ctx.lineTo(largura - dir, y(v));
        ctx.stroke();
        ctx.fillText(Math.round(v) + " " + unidade, 2, y(v) + 4);
    }

    hist.pior.forEach((v, i) => {
        ctx.fillStyle = v > limite ? "#cc092f" : "#9a8f94";
        ctx.fillRect(x(i) - slot * 0.275, y(v), slot * 0.55, cima + areaA - y(v));
    });

    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#17120f";
    ctx.beginPath();
    ctx.moveTo(esq, y(limite));
    ctx.lineTo(largura - dir, y(limite));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    hist.media.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.fillStyle = "#fff";
    hist.media.forEach((v, i) => {
        ctx.beginPath();
        ctx.arc(x(i), y(v), 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    });

    ctx.fillStyle = "#5c5256";
    ctx.fillText("há 45 s", esq, altura - 6);
    ctx.textAlign = "center";
    ctx.fillText("há 22 s", esq + areaL / 2, altura - 6);
    ctx.textAlign = "right";
    ctx.fillText("agora", largura - dir, altura - 6);
    ctx.textAlign = "left";
}

function desenharGraficos() {
    desenharGrafico("chartApi", historicoApi, limiteCritico, "ms", 1000);
    desenharGrafico("chartRede", historicoRede, limiteAtaque, "%", 60);
}

function guardarHistorico(hist, lista, campo) {
    hist.media.push(media(lista, campo));
    hist.pior.push(maximo(lista, campo));
    if (hist.media.length > limitePontos) {
        hist.media.shift();
        hist.pior.shift();
    }
}

function renderTudo() {
    atualizarCards();
    atualizarTabelas();
    renderIncidentes();
    desenharGraficos();
}

function atualizarTudo() {
    servicos.forEach((s, i) => {
        atualizarServico(s);
        verificarServico(s, i);
    });
    segmentos.forEach((s, i) => {
        atualizarSegmento(s);
        verificarSegmento(s, i);
    });

    manterIncidentesAbertos();
    guardarHistorico(historicoApi, servicos, "latencia");
    guardarHistorico(historicoRede, segmentos, "anomalia");
    renderTudo();
}

function simularFalhaTecnica() {
    forcarAte = Date.now() + 6000;
    const s = servicos[Math.floor(Math.random() * servicos.length)];

    iniciarQueda(s);
    s.pico = aleatorio(900, 2000);
    atualizarTudo();
}

function simularAtaque() {
    forcarAte = Date.now() + 6000;
    const s = servicos[Math.floor(Math.random() * servicos.length)];
    const seg = segmentos[s.segmento];

    iniciarQueda(s);
    s.pico = aleatorio(1500, 2600);
    seg.anomalia = aleatorio(32, 38);
    seg.queda = 10;
    seg.pico = aleatorio(55, 75);
    atualizarTudo();
}

function trocarTela(evento) {
    document.querySelectorAll("nav a, .view").forEach((el) => el.classList.remove("on"));
    evento.currentTarget.classList.add("on");
    $("view-" + evento.currentTarget.dataset.view).classList.add("on");
    desenharGraficos();
}

function iniciar() {
    carregarAuditoria();

    aquecendo = true;
    for (let i = 0; i < limitePontos; i++) atualizarTudo();
    aquecendo = false;

    servicos.forEach((s) => Object.assign(s, { latencia: s.base, erros: 0, queda: 0, status: "ok" }));
    segmentos.forEach((s) => Object.assign(s, { trafego: s.base, anomalia: 4, queda: 0, status: "ok" }));

    renderTudo();
    renderAuditoria();
    renderAcesso();
}

$("btnFalha").addEventListener("click", simularFalhaTecnica);
$("btnAtaque").addEventListener("click", simularAtaque);

$("btnPausar").addEventListener("click", () => {
    pausado = !pausado;
    $("btnPausar").textContent = pausado ? "Retomar" : "Pausar";
});

$("perfil").addEventListener("change", (evento) => {
    perfilAtual = evento.target.value;
    $("avatar").textContent = perfis[perfilAtual].sigla;
    renderIncidentes();
    renderAcesso();
});

$("listaIncidentes").addEventListener("click", (evento) => {
    const botao = evento.target.closest("button");

    if (botao && !botao.disabled) responder(botao.dataset.id, botao.dataset.acao === "aprovar");
});

document.querySelectorAll("nav a").forEach((link) => link.addEventListener("click", trocarTela));
window.addEventListener("resize", desenharGraficos);
setInterval(() => !pausado && atualizarTudo(), 1500);
window.onload = iniciar;