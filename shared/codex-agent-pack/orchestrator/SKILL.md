---
name: orchestrator
description: Bộ điều phối bắt buộc. Với MỌI yêu cầu, xác định skill/persona phù hợp và áp dụng vòng đời DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP trước khi làm. Use when starting any task, mapping user intent to skills, or coordinating personas.
---

# Orchestrator — Điều phối skill & vòng đời

Đây là skill trung tâm. Trước khi làm bất kỳ việc gì, chạy quy trình điều phối này.

## Quy trình bắt buộc cho MỖI yêu cầu

1. **Nhận diện intent** → map sang skill (dù chỉ 1% khả năng khớp cũng phải kiểm tra).
2. **Gọi skill phù hợp**, làm theo đúng workflow của skill (không áp dụng nửa vời).
3. Chỉ bắt tay implement sau khi các bước bắt buộc (spec, plan) đã xong.

## Bản đồ Intent → Skill

- Tính năng mới → `spec-driven-development` → `planning-and-task-breakdown` → `incremental-implementation` + `test-driven-development`
- Lập kế hoạch / chia nhỏ → `planning-and-task-breakdown`
- Bug / lỗi / hành vi lạ → `debugging-and-error-recovery`
- Review code → `code-review-and-quality`
- Refactor / đơn giản hoá → `code-simplification`
- Thiết kế API / interface → `api-and-interface-design`
- UI → `frontend-ui-engineering`
- Bảo mật → `security-and-hardening`
- Hiệu năng → `performance-optimization`
- Observability → `observability-and-instrumentation`
- Deploy / release → `shipping-and-launch`
- Ý tưởng còn mơ hồ → `idea-refine` / `interview-me`
- Cần tài liệu chính thống → `source-driven-development`
- Quyết định rủi ro cao → `doubt-driven-development`

## Vòng đời (áp dụng xuyên suốt)

```
DEFINE  → spec-driven-development
PLAN    → planning-and-task-breakdown
BUILD   → incremental-implementation + test-driven-development
VERIFY  → debugging-and-error-recovery
REVIEW  → code-review-and-quality
SHIP    → shipping-and-launch
```

## Điều phối persona

- Persona KHÔNG gọi persona khác. Người dùng (hoặc lệnh) là orchestrator.
- Mẫu duy nhất được phép: **fan-out song song + merge** (như `/ship`: chạy song song
  `code-reviewer` + `security-auditor` + `test-engineer` rồi tổng hợp).
- Không xây "router persona".

## Chống viện cớ (ignore các suy nghĩ sai sau)

- "Việc này nhỏ khỏi cần skill"
- "Cứ code nhanh cho xong"
- "Để gom context trước đã"

→ Đúng: LUÔN kiểm tra & dùng skill trước.

## Definition of Done

Xem `rules/definition-of-done.md`. Không tuyên bố hoàn thành nếu chưa: code chạy,
test pass, build sạch, tài liệu/quyết định được ghi lại.
