'use strict';
const planner = document.querySelector('#planner');
const status = document.querySelector('#status');
planner.addEventListener('submit', (event) => event.preventDefault());
planner.addEventListener('reset', () => {
  status.textContent = 'Sample day restored.';
});
planner.addEventListener('input', () => {
  status.textContent = 'Preview updated. Changes are only kept on this page.';
});
