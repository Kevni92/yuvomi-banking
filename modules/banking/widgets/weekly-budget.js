export async function renderWidget(container) {
  container.replaceChildren();

  const wrapper = document.createElement('div');
  wrapper.className = 'banking-weekly-widget';

  const title = document.createElement('strong');
  title.textContent = 'Wochenbudget';

  const text = document.createElement('p');
  text.textContent = 'Noch nicht eingerichtet.';

  wrapper.append(title, text);
  container.append(wrapper);
}
