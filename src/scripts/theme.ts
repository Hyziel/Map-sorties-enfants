/**
 * Bascule clair / sombre.
 *
 * Sans choix explicite on suit le système (`prefers-color-scheme`). Dès que
 * l'utilisateur touche au bouton, son choix est mémorisé et prend le pas.
 * Le thème est déjà posé sur <html> par le script inline du <head> : ici on
 * ne gère que l'état du bouton et le clic.
 */

const bouton = document.getElementById('bascule-theme');
if (bouton) {
  const systemeSombre = window.matchMedia('(prefers-color-scheme: dark)');

  const actuel = (): 'clair' | 'sombre' => {
    const choisi = document.documentElement.dataset.theme;
    if (choisi === 'clair' || choisi === 'sombre') return choisi;
    return systemeSombre.matches ? 'sombre' : 'clair';
  };

  const majBouton = () => {
    const sombre = actuel() === 'sombre';
    bouton.setAttribute('aria-pressed', String(sombre));
    bouton.title = sombre ? 'Passer au thème clair' : 'Passer au thème sombre';
    bouton.querySelector('.icone')!.textContent = sombre ? '☀️' : '🌙';
  };

  bouton.addEventListener('click', () => {
    const suivant = actuel() === 'sombre' ? 'clair' : 'sombre';
    document.documentElement.dataset.theme = suivant;
    try {
      localStorage.setItem('theme', suivant);
    } catch {
      /* Choix non mémorisé, mais appliqué pour la session. */
    }
    majBouton();
  });

  // Tant qu'aucun choix n'est mémorisé, suivre les changements du système.
  systemeSombre.addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) majBouton();
  });

  majBouton();
}
