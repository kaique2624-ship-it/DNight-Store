/* Função única da Vercel: todas as rotas /api/* chegam aqui (veja vercel.json) */
const { handle } = require("../lib/loja");
module.exports = (req, res) => handle(req, res);
module.exports.config = { maxDuration: 60 };
