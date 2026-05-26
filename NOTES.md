# 참고 사항

## Cron 일정 — 두 파일을 항상 동기화할 것

빌드 일정은 두 곳에 정의되어 있으며, 변경 시 반드시 두 파일 모두 수정해야 합니다:

- `config.js` → `schedule` 필드
- `.github/workflows/merge.yml` → `on.schedule` 아래의 `cron` 값

GitHub Actions는 오직 `merge.yml`에서만 일정을 읽습니다. `config.js`의 값은 워크플로우 실행 시각에 아무런 영향을 미치지 않으며, 의도한 일정을 한 곳에서 관리하기 위한 참조용으로만 존재합니다.

일정을 변경할 경우 두 파일을 모두 수정하십시오. 두 값이 어긋나면 `merge.yml`에 명시된 일정대로만 워크플로우가 실행됩니다.

---

# Notes

## Cron schedule — keep in sync manually

The build schedule is defined in two places and must be updated in both:

- `config.js` → `schedule` field
- `.github/workflows/merge.yml` → `cron` value under `on.schedule`

GitHub Actions only reads the schedule from `merge.yml`. The value in `config.js` has no effect on when the workflow runs — it exists solely as a reference for the intended schedule, not as something GitHub reads directly.

If you change the schedule, update both files. If they drift apart, the workflow will run on whatever `merge.yml` says, silently ignoring `config.js`.
