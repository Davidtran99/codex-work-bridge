# Cài Codex ↔ Work Bridge vào MCP

Tài liệu này hướng dẫn cài MCP server cục bộ vào Codex CLI, Codex IDE extension và ChatGPT desktop app. Server cung cấp 12 tool: đọc/tạo/cập nhật/kiểm tra/đóng gói handoff, đồng bộ + xuất bản qua git, và CHAT có thread (bất đồng bộ) giữa Codex IDE và ChatGPT Work.

## 1. Hiểu đúng mô hình kết nối

```text
Codex IDE ── MCP STDIO ── thư mục codex-work-bridge ── GitHub ── ChatGPT Work
```

- MCP STDIO chạy trên máy của bạn và thao tác với thư mục Bridge.
- Codex CLI, Codex IDE extension và ChatGPT desktop app dùng chung cấu hình MCP cục bộ trong `~/.codex/config.toml`.
- ChatGPT Work trên web **không đọc MCP hoặc file cục bộ trên máy bạn**. Work cần plugin GitHub để truy cập repository chung, hoặc bạn tải gói ZIP lên thủ công.
- Nếu muốn cả hai phía cùng gọi đúng một MCP server, bạn phải triển khai bản Streamable HTTP từ xa kèm xác thực. Bản này cố ý dùng STDIO vì an toàn và dễ cài hơn.

Tài liệu chính thức: [Codex MCP](https://developers.openai.com/codex/mcp) và [MCP TypeScript SDK](https://modelcontextprotocol.io/docs/sdk).

## 2. Yêu cầu hệ thống

- macOS, Linux hoặc WSL.
- Node.js 20 trở lên.
- npm.
- Python 3.9 trở lên.
- Codex CLI/IDE extension phiên bản có hỗ trợ MCP.
- Git, nếu đồng bộ qua GitHub.

Kiểm tra:

```bash
node --version
npm --version
python3 --version
codex --version
git --version
```

Nếu `node --version` thấp hơn 20 và bạn dùng Homebrew:

```bash
brew install node
```

## 3. Giải nén và đặt project

Ví dụ trên macOS:

```bash
cd ~/Documents
unzip ~/Downloads/codex-work-bridge.zip
cd ~/Documents/codex-work-bridge
```

Không di chuyển thư mục sau khi đã cài MCP. Nếu di chuyển, hãy chạy lại script cài đặt để cập nhật đường dẫn tuyệt đối.

## 4. Cài tự động — khuyến nghị

Từ thư mục project:

```bash
chmod +x scripts/install-mcp.sh scripts/uninstall-mcp.sh
./scripts/install-mcp.sh
```

Script sẽ:

1. Kiểm tra Node, npm và Codex CLI.
2. Cài dependency bằng `npm install`.
3. Chạy smoke test MCP.
4. Xóa cấu hình Bridge cũ nếu có.
5. Thêm server bằng `codex mcp add` với đường dẫn tuyệt đối.

Kiểm tra sau cài đặt:

```bash
codex mcp list
```

Sau đó khởi động lại Codex IDE extension. Mở task mới và nhập:

```text
/mcp
```

Bạn phải thấy server `codex-work-bridge` cùng 12 tool.

## 5. Cài thủ công bằng CLI

Lấy đường dẫn project và Node:

```bash
cd ~/Documents/codex-work-bridge
pwd
which node
npm install
npm run mcp:smoke
```

Ví dụ nếu kết quả là:

```text
/Users/david/Documents/codex-work-bridge
/opt/homebrew/bin/node
```

Chạy:

```bash
codex mcp add codex-work-bridge \
  --env CODEX_WORK_BRIDGE_ROOT=/Users/david/Documents/codex-work-bridge \
  -- /opt/homebrew/bin/node /Users/david/Documents/codex-work-bridge/mcp-server/src/index.js
```

Kiểm tra:

```bash
codex mcp list
codex mcp --help
```

## 6. Cài bằng giao diện Codex IDE

1. Mở biểu tượng bánh răng trong Codex IDE.
2. Chọn **MCP servers** → **Add server**.
3. Tên: `codex-work-bridge`.
4. Transport: `STDIO`.
5. Command: đường dẫn trả về từ `which node`.
6. Arguments: đường dẫn tuyệt đối đến `mcp-server/src/index.js`.
7. Environment variable:
   - Tên: `CODEX_WORK_BRIDGE_ROOT`
   - Giá trị: đường dẫn tuyệt đối đến project.
8. Lưu và chọn **Restart extension**.
9. Mở task mới, nhập `/mcp` để kiểm tra.

## 7. Cài bằng config.toml

Mở cấu hình người dùng:

```bash
mkdir -p ~/.codex
open ~/.codex/config.toml
```

Trên Linux:

```bash
mkdir -p ~/.codex
${EDITOR:-nano} ~/.codex/config.toml
```

Sao chép mẫu từ `.codex/config.example.toml` và thay ba đường dẫn tuyệt đối:

```toml
[mcp_servers.codex-work-bridge]
command = "/opt/homebrew/bin/node"
args = ["/Users/david/Documents/codex-work-bridge/mcp-server/src/index.js"]
startup_timeout_sec = 15
tool_timeout_sec = 60
enabled = true
required = false
default_tools_approval_mode = "writes"

[mcp_servers.codex-work-bridge.env]
CODEX_WORK_BRIDGE_ROOT = "/Users/david/Documents/codex-work-bridge"
```

`default_tools_approval_mode = "writes"` cho phép tool chỉ đọc chạy thuận tiện hơn và yêu cầu xác nhận cho tool ghi file.

Bạn cũng có thể đặt cấu hình vào `.codex/config.toml` của repository. Project phải được Codex đánh dấu là trusted thì cấu hình theo project mới có hiệu lực.

## 8. Các MCP tool có sẵn

| Tool | Loại | Tác dụng |
| --- | --- | --- |
| `bridge_status` | Đọc | Đọc trạng thái project và danh sách handoff |
| `list_handoffs` | Đọc | Lọc handoff theo chiều hoặc trạng thái |
| `read_handoff` | Đọc | Đọc manifest, request, response và file đính kèm |
| `create_handoff` | Ghi | Tạo handoff mới |
| `write_handoff_text_file` | Ghi | Tạo file văn bản trong `files/` |
| `update_handoff` | Ghi | Cập nhật phản hồi và trạng thái |
| `validate_bridge` | Đọc | Kiểm tra cấu trúc handoff |
| `pack_handoff` | Ghi | Tạo ZIP trong `.bridge/packages/` |
| `sync_handoffs` | Git (an toàn) | Fetch/prune + fast-forward CHỈ; từ chối nếu worktree bẩn hoặc branch lệch. Không merge/reset/force |
| `publish_handoff` | Git (an toàn) | Validate → commit CHỈ thư mục handoff lên branch `bridge/<direction>/<id>` → push, rồi quay lại base branch. Không đụng main, không force-push, quét secret |
| `chat_send` | Chat/Git | Gửi 1 tin nhắn lên thread `bridge/chat/<thread_id>` (mỗi tin = 1 file JSON, id chống trùng). Commit chỉ thư mục thread, push, quay lại base. Quét secret |
| `chat_read` | Chat (đọc) | Fetch + đọc thread thẳng từ remote-tracking ref, KHÔNG merge. `since_id` để chỉ lấy tin mới (dedupe) |

Server chặn đường dẫn thoát ra ngoài project, giới hạn file văn bản ở 1 MiB và từ chối một số mẫu secret phổ biến. Hai tool git (`sync_handoffs`, `publish_handoff`) là workflow cấp cao có bảo vệ: chỉ fast-forward khi sync; khi publish chỉ commit đúng thư mục handoff, luôn tạo branch riêng `bridge/<direction>/<id>` (một handoff = một branch), không bao giờ push thẳng `main` và không force-push.

## 9. Test bằng Codex IDE

Trong một task mới, gửi nguyên văn:

```text
Sử dụng MCP codex-work-bridge.
1. Gọi bridge_status.
2. Gọi list_handoffs với limit 10.
3. Đọc handoff work-to-ide mới nhất.
4. Đọc file hello-from-work.txt được liệt kê trong handoff và báo nội dung.
Không sửa file nào.
```

Test tạo handoff:

```text
Sử dụng MCP codex-work-bridge để tạo một handoff ide-to-work tên "MCP install test".
Nội dung REQUEST.md phải ghi mục tiêu kiểm tra MCP, tiêu chí validate thành công và không chứa dữ liệu bí mật.
Sau đó gọi validate_bridge và pack_handoff. Báo lại ID cùng đường dẫn ZIP.
```

## 10. Test độc lập bằng MCP client

Không cần mở Codex IDE:

```bash
cd ~/Documents/codex-work-bridge
npm install
npm run mcp:smoke
```

Kết quả đúng:

```text
MCP smoke test passed: 12 tools; create, write, update, validate, pack, publish, sync and threaded chat succeeded.
```

Bạn cũng có thể dùng MCP Inspector:

```bash
npx @modelcontextprotocol/inspector \
  node "$PWD/mcp-server/src/index.js"
```

Inspector mở trình duyệt cục bộ. Chọn **Connect**, mở **Tools** và gọi `bridge_status`.

## 11. Đồng bộ GitHub để Work nhận dữ liệu

Trong thư mục Bridge:

```bash
git init
git add .
git commit -m "Add Codex Work MCP bridge"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/codex-work-bridge.git
git push -u origin main
```

Sau mỗi handoff do Codex IDE tạo:

```bash
git status
git add exchange PROJECT_STATE.md
git commit -m "bridge: add IDE to Work handoff"
git push
```

Sau đó trong ChatGPT Work, gửi repository và branch, ví dụ:

```text
Mở repository YOUR_NAME/codex-work-bridge bằng GitHub plugin.
Đọc handoff ide-to-work mới nhất, thực hiện yêu cầu, tạo phản hồi work-to-ide,
validate rồi commit kết quả lên một branch mới để tôi review.
```

Không đưa `.env`, token hoặc credential vào GitHub. Repository private chỉ nên được mở qua plugin GitHub đã cấp quyền phù hợp.

## 12. Gỡ cài đặt

Khuyến nghị:

```bash
cd ~/Documents/codex-work-bridge
./scripts/uninstall-mcp.sh
```

Hoặc:

```bash
codex mcp remove codex-work-bridge
codex mcp list
```

Nếu Codex CLI không nhận lệnh `remove`, mở `~/.codex/config.toml`, xóa hai bảng:

```toml
[mcp_servers.codex-work-bridge]
[mcp_servers.codex-work-bridge.env]
```

Sau đó khởi động lại Codex IDE extension. Gỡ MCP không xóa project hoặc handoff.

## 13. Xử lý lỗi

### Không thấy server trong `/mcp`

```bash
codex mcp list
which node
test -f "$HOME/Documents/codex-work-bridge/mcp-server/src/index.js" && echo OK
```

Kiểm tra đường dẫn tuyệt đối trong config, sau đó restart extension và mở task mới.

### `node: command not found`

Cài Node 20+ và dùng đường dẫn tuyệt đối từ `which node` trong cấu hình MCP.

### `Cannot find package @modelcontextprotocol/sdk`

```bash
cd ~/Documents/codex-work-bridge
npm install
npm run mcp:smoke
```

### Server khởi động rồi tắt

Chạy trực tiếp để xem lỗi trên stderr:

```bash
cd ~/Documents/codex-work-bridge
CODEX_WORK_BRIDGE_ROOT="$PWD" node mcp-server/src/index.js
```

Nếu chạy đúng, server sẽ chờ dữ liệu trên stdin. Nhấn `Ctrl+C` để dừng.

### `bridge.py exited`

```bash
cd ~/Documents/codex-work-bridge
python3 bridge.py validate
python3 bridge.py status
```

Sửa handoff được báo lỗi rồi restart Codex.

### Work không thấy file mới

MCP cục bộ không tự upload file. Kiểm tra Git:

```bash
git status
git log -1 --oneline
git remote -v
git push
```

Sau đó yêu cầu Work đọc đúng repository và branch bằng GitHub plugin.

## 14. Bảo mật

- Không thêm token vào `bridge.config.json`, `handoff.json`, `REQUEST.md`, `RESPONSE.md` hoặc `files/`.
- Không dùng `default_tools_approval_mode = "approve"` khi chưa hiểu rõ tác động.
- Chỉ cấp GitHub plugin quyền vào repository cần thiết.
- Review `git diff` trước mỗi lần push.
- Không triển khai MCP HTTP công khai nếu chưa có HTTPS, authentication, authorization, rate limiting và audit log.

