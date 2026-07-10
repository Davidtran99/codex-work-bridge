# Request: Test kết nối hai chiều

## Goal

Xác nhận ChatGPT Work có thể nhận handoff từ Codex IDE và gửi một file phản hồi hợp lệ.

## Context

Đây là bài kiểm thử end-to-end đầu tiên của Codex ↔ Work Bridge.

## Requested work

- [x] Đọc yêu cầu từ thư mục `ide-to-work`.
- [ ] Tạo file `hello-from-work.txt` chứa thông điệp xác nhận.
- [ ] Gửi phản hồi qua một handoff `work-to-ide`.

## Allowed scope

Chỉ được tạo handoff kiểm thử và cập nhật `PROJECT_STATE.md`.

## Acceptance criteria

- [ ] Handoff hai chiều vượt qua lệnh `validate`.
- [ ] Cả hai handoff đóng gói được thành ZIP.
- [ ] File phản hồi tồn tại và có nội dung dễ kiểm chứng.

## Verification

Chạy `python3 bridge.py validate`, sau đó kiểm tra hai gói ZIP bằng `unzip -t`.

## Blockers or risks

None known.
