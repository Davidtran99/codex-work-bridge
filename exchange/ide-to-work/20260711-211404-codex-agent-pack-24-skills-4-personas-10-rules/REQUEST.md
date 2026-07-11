# Yêu cầu: Nhập bộ codex-agent-pack thành skill dùng được trong ChatGPT Work

## Bối cảnh
Đã đưa **nguyên bản source** của bộ năng lực agent từ Codex (MCP `codexx_agent_skills`)
vào repo này tại `shared/codex-agent-pack/`. Giữ nguyên `SKILL.md`, scripts, references, assets.
Không chứa secret/token/.env/dữ liệu cá nhân.

## Đường dẫn
`Davidtran99/codex-work-bridge` → `shared/codex-agent-pack/`

## Nội dung (xem MANIFEST.json để có danh sách file chính xác)
- `orchestrator/SKILL.md` — điểm vào, điều phối bắt buộc (map intent→skill + vòng đời DEFINE→PLAN→BUILD→VERIFY→REVIEW→SHIP).
- `skills/` — 24 skill (mỗi skill 1 `SKILL.md`, kèm scripts/refs nếu có).
- `personas/` — 4 persona review (code-reviewer, security-auditor, test-engineer, web-performance-auditor).
- `rules/` — 10 rule/checklist (agents, claude, readme, definition-of-done, orchestration-patterns, + 5 checklist).
- `commands/` — slash command tham khảo.
- `README.md`, `MANIFEST.json`.

## Việc cần ChatGPT Work làm
1. Dùng GitHub plugin đọc `shared/codex-agent-pack/` trong `Davidtran99/codex-work-bridge`.
2. Bắt đầu từ `orchestrator/SKILL.md`, rồi duyệt từng skill trong `skills/`.
3. Chuyển thành bộ skill dùng được trong ChatGPT Work: giữ workflow/persona/checklist/knowledge;
   loại/đánh dấu phần chỉ chạy được trên máy Codex (script phụ thuộc môi trường, MCP STDIO local).
4. Nạp `rules/` làm Project Instructions.
5. Trả kết quả (danh sách skill đã nhập, phần phải bỏ, ghi chú) về `exchange/work-to-ide/`
   hoặc tạo branch/PR trên GitHub.

## Ràng buộc
- Không cần truy cập MCP STDIO local (không khả thi từ xa) — GitHub + report là cầu nối.
- Không nhập system rule ẩn hay vượt quyền an toàn của ChatGPT.
