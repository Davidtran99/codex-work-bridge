# Request: Xác nhận kết nối hai chiều thật

## Goal
Hoàn tất vòng trao đổi hai chiều Codex IDE ↔ ChatGPT Work qua repo `Davidtran99/codex-work-bridge`. Handoff này do phía Codex IDE tạo và push lên `main`; cần Work xử lý và phản hồi thật.

## Context
- MCP `codex-work-bridge` đã cài cục bộ (8 tool STDIO), đăng ký trong `~/.codex/config.toml`.
- Repo đã public, Work xác nhận đọc được README + cả hai chiều handoff + `hello-from-work.txt`.
- Đây là handoff thật đầu tiên (đã xoá các handoff test trước đó).

## Requested work
- [ ] Work xác nhận đã NHẬN handoff này (đọc REQUEST.md).
- [ ] Work tạo file `work-connection-confirmed.txt` trong `files/` của handoff phản hồi.
- [ ] Work tạo handoff chiều `work-to-ide` phản hồi, parent trỏ về id handoff này.
- [ ] Work commit lên một BRANCH MỚI để review (không đẩy thẳng vào main).

## Allowed scope
- Chỉ thao tác trong thư mục `exchange/` của bridge.
- KHÔNG chạm mã nguồn, config, secrets, `.env`.
- KHÔNG đặt token/khoá/cookie vào bất kỳ file handoff nào.

## Acceptance criteria
- [ ] `python3 bridge.py validate` báo tất cả handoff hợp lệ.
- [ ] Có handoff `work-to-ide` mới với `parent_handoff` = id handoff này.
- [ ] File `work-connection-confirmed.txt` đọc được và xác nhận kết nối.
- [ ] Phản hồi nằm trên branch riêng để Codex IDE review trước khi merge.

## Verification
```
cd ~/Documents/codex-work-bridge
git fetch origin
git branch -a
python3 bridge.py validate
python3 bridge.py status
```

## Blockers or risks
- Work web đọc/ghi qua GitHub, không gọi trực tiếp MCP cục bộ.
- Repo đang public: tuyệt đối không đưa dữ liệu nhạy cảm vào handoff.
