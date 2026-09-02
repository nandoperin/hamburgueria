/**
 * Health check de processo para a fase de testes.
 *
 * O Railway precisa apenas saber que o servidor iniciou e consegue responder.
 * Banco, WhatsApp e impressora ficam deliberadamente fora daqui: durante a
 * validacao do produto eles podem estar desligados sem derrubar o deploy.
 */
async function verificar() {
  return {
    ok: true,
    uptime: Math.round(process.uptime()),
  };
}

module.exports = { verificar };
