# patches/ — НАШЕ поверх pristine upstream (правило: своё и сурс разделены).

Upstream: jkudish/jev-mcp (remote `origin`), этот форк: deadczarvc/jev-mcp
(remote `fork`). Ветка main форка = зеркало origin/main + ТОЛЬКО этот каталог.
Никаких правок в `src/` коммитами — только патч-файлы здесь + запись ниже.

- exp-carve-out-JEV_VERIFY_EXP.patch — локальный эксперимент (f036230):
  scope/superseded/carve вопросы за `JEV_VERIFY_EXP=1`. Негативный результат
  (MI 0.001 bit), не для upstream. Применение: `git apply patches/*.patch`
  после checkout нужного тега. Проверка: `npm test` (или scripts/run_tests.sh
  upstream).
- 067dd2a (subject-gate) — СНЯТ 2026-10-16: поглощён upstream 0.13.0 (PR #54).
- Поглощения фиксировать здесь строкой, как эта, а не удалением молча.
