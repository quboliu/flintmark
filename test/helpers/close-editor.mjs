// A reused profile must not be relaunched until the previous owned process exits.
export async function closeEditor(app) {
  if (!app) return;
  const process = app.process();
  if (!process) throw new Error('Cannot verify owned editor process shutdown');
  const exited = () => process.exitCode !== null || process.signalCode !== null;
  const waitForExit = async (timeout) => {
    if (exited()) return true;
    return new Promise(resolve => {
      const finish = result => { clearTimeout(timer); process.off('exit', onExit); resolve(result); };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(exited()), timeout);
      process.once('exit', onExit);
      if (exited()) finish(true);
    });
  };
  let closeError;
  // Observe errors immediately, but process exit is the shutdown completion signal.
  const closing = app.close().catch(error => { closeError = error; });
  if (!(await waitForExit(5000))) {
    process.kill('SIGTERM');
    if (!(await waitForExit(5000))) {
      process.kill('SIGKILL');
      if (!(await waitForExit(5000))) throw new Error('Owned editor did not exit; refusing to reuse its profile');
    }
  }
  console.log('EDITOR_PROCESS_EXIT', JSON.stringify({pid:process.pid,exitCode:process.exitCode,signalCode:process.signalCode,closeError:closeError?.message}));
  void closing;
}
