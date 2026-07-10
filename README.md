# Codex ↔ Work Bridge

Project này tạo một hộp thư file hai chiều giữa:

- **Codex IDE**: làm việc trực tiếp trong repository trên máy.
- **ChatGPT Work**: nhận yêu cầu, đọc file, tạo/sửa tài liệu và gửi kết quả trở lại.

GitHub là nguồn đồng bộ chung. Nếu chưa dùng GitHub, bạn vẫn có thể trao đổi bằng các gói ZIP do `bridge.py` tạo ra.

Project hiện có MCP server cục bộ cho Codex IDE. Xem hướng dẫn đầy đủ tại [`MCP_SETUP.md`](MCP_SETUP.md).

## Cấu trúc

```text
exchange/
  ide-to-work/       # Codex IDE gửi sang Work
  work-to-ide/       # Work gửi lại Codex IDE
  archive/           # Các lượt đã hoàn tất
PROJECT_STATE.md      # Trạng thái và quyết định hiện tại
AGENTS.md             # Quy tắc để Codex IDE tự hiểu quy trình
bridge.py             # Tạo, kiểm tra và đóng gói handoff
mcp-server/            # MCP STDIO server cho Codex IDE
scripts/               # Script cài và gỡ MCP
```

Mỗi handoff là một thư mục độc lập:

```text
20260710-153000-fix-study-ui/
  handoff.json
  REQUEST.md
  RESPONSE.md
  files/
```

## Bắt đầu nhanh

Yêu cầu Python 3.9 trở lên, không cần cài thư viện.

```bash
python3 bridge.py init
python3 bridge.py new ide-to-work "Sửa giao diện trang học"
python3 bridge.py status
python3 bridge.py validate
```

Lệnh `new` in ra đường dẫn của handoff mới. Hãy:

1. Viết yêu cầu vào `REQUEST.md`.
2. Chép file cần gửi vào thư mục `files/`.
3. Chạy `python3 bridge.py pack <đường-dẫn-handoff>`.
4. Commit/push lên GitHub hoặc tải ZIP lên ChatGPT Work.

## Luồng Codex IDE → Work

Nói với Codex IDE:

> Đọc AGENTS.md. Tạo một handoff ide-to-work cho nhiệm vụ hiện tại, ghi rõ mục tiêu, việc đã làm, việc cần Work xử lý, lệnh kiểm thử và các file liên quan. Sau đó validate và pack handoff.

Sau khi Codex tạo xong:

- Nếu dùng GitHub: commit và push branch; gửi repository/branch cho Work.
- Nếu dùng thủ công: tải file ZIP trong `.bridge/packages/` lên Work.

## Luồng Work → Codex IDE

Work tạo handoff trong `exchange/work-to-ide/`, ghi kết quả vào `RESPONSE.md` và đặt file trả về trong `files/`.

Nói với Codex IDE:

> Đọc handoff mới nhất trong exchange/work-to-ide, kiểm tra RESPONSE.md và áp dụng các file được gửi lại. Chạy test trước khi đánh dấu hoàn tất.

## Quy tắc an toàn

- Không đặt mật khẩu, token, cookie, API key hoặc dữ liệu đăng nhập vào handoff.
- Không gửi toàn bộ repository nếu chỉ cần vài file liên quan.
- Ghi rõ file nào được phép sửa và tiêu chí hoàn thành.
- Không ghi đè thay đổi chưa commit của phía còn lại.
- Mọi kết quả phải kèm cách kiểm tra hoặc lý do chưa thể kiểm tra.

## Đồng bộ qua GitHub

Khuyến nghị mỗi lượt dùng một branch:

```text
bridge/ide-to-work/<slug>
bridge/work-to-ide/<slug>
```

Hai phía trao đổi qua commit/PR. `handoff.json` là trạng thái máy đọc được; `REQUEST.md` và `RESPONSE.md` là nội dung để con người và agent cùng đọc.
