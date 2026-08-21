const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.join(__dirname, '..', '.bot.lock');

/**
 * Garante uma única instância do bot rodando.
 *
 * Duas instâncias compartilhando auth_info_baileys se atropelam e o WhatsApp
 * derruba a sessão (o cliente é deslogado e o QR precisa ser escaneado de novo).
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // existe, mas de outro usuário
  }
}

function acquire() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());

    if (pid && pid !== process.pid && isAlive(pid)) {
      console.error(
        `\nJá existe uma instância do bot rodando (PID ${pid}).\n` +
          'Rodar duas ao mesmo tempo derruba a sessão do WhatsApp.\n' +
          'Encerre a outra antes de iniciar esta.\n'
      );
      process.exit(1);
    }

    // Lock órfão de um processo que morreu — pode sobrescrever.
    fs.unlinkSync(LOCK_FILE);
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid));

  const release = () => {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
        if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
      }
    } catch {
      // encerrando de qualquer forma
    }
  };

  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

module.exports = { acquire };
