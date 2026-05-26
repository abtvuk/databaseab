# Security Policy

## Supported Versions

This repository is a live data feed. The only active version is the current state of the `main` branch.

## Reporting a Vulnerability

If you discover a security issue in this repository — including malicious stream URLs in the feed data, workflow vulnerabilities, or anything that could harm users of this project — please **do not open a public issue**.

Instead, report it privately via GitHub's built-in vulnerability reporting:

1. Go to the **Security** tab of this repository
2. Click **"Report a vulnerability"**
3. Describe the issue clearly, including steps to reproduce if applicable

You can expect an acknowledgement within **72 hours** and a resolution or status update within **7 days**.

## Scope

The following are in scope for security reports:

- Malicious or harmful URLs present in any feed file (`feeds/custom/`, `feeds/youtube/`)
- GitHub Actions workflow vulnerabilities that could allow unauthorized code execution or branch tampering
- Any content in the merged output that could be used to harm end users

## Out of Scope

- Dead or broken stream URLs — these are a data quality issue, not a security issue. Open a regular issue for those.
- Streams from iptv-org that are geo-blocked or legally restricted in your region — report those upstream to [iptv-org](https://github.com/iptv-org/iptv)

---

# 보안 정책

## 지원 버전

이 저장소는 실시간 데이터 피드입니다. 유일하게 유지되는 버전은 `main` 브랜치의 현재 상태입니다.

## 취약점 신고

피드 데이터 내 악성 스트림 URL, 워크플로우 취약점, 또는 이 프로젝트 사용자에게 해를 끼칠 수 있는 문제를 발견하셨다면 **공개 이슈를 열지 마십시오**.

대신 GitHub의 내장 취약점 신고 기능을 통해 비공개로 제보해 주십시오:

1. 이 저장소의 **Security** 탭으로 이동합니다
2. **"Report a vulnerability"** 를 클릭합니다
3. 재현 방법을 포함하여 문제를 명확하게 설명합니다

**72시간** 이내에 접수 확인을 받으실 수 있으며, **7일** 이내에 해결 여부 또는 진행 상황을 안내해 드립니다.

## 신고 범위

다음 항목은 보안 신고 대상에 해당합니다:

- 피드 파일(`feeds/custom/`, `feeds/youtube/`)에 포함된 악성 또는 유해한 URL
- 무단 코드 실행 또는 브랜치 변조를 허용할 수 있는 GitHub Actions 워크플로우 취약점
- 최종 사용자에게 해를 끼칠 수 있는 병합 출력 내 콘텐츠

## 신고 범위 외

- 끊기거나 작동하지 않는 스트림 URL — 이는 보안 문제가 아닌 데이터 품질 문제입니다. 일반 이슈로 등록해 주십시오.
- 해당 지역에서 지역 차단되거나 법적으로 제한된 iptv-org 스트림 — [iptv-org](https://github.com/iptv-org/iptv) 에 직접 신고해 주십시오.
