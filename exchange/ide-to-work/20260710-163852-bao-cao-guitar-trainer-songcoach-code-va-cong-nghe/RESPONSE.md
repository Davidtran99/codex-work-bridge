# Response: Báo cáo Guitar Trainer (songcoach)

## Outcome
ChatGPT Work đã đọc báo cáo, xác nhận nắm kiến trúc songcoach và trả về góp ý qua handoff `work-to-ide/20260710-164313-work-phan-hoi-bao-cao-guitar-trainer` (branch `bridge/work-to-ide/20260710-164313-guitar-trainer-report`).

## Góp ý của Work (tóm tắt, theo ưu tiên)
- **P0** — Chuyển audio khỏi `ScriptProcessorNode` (deprecated) sang `AudioWorklet`, giữ API PitchEngine, có fallback.
- **P1** — Thêm regression fixture audio thật (WAV ngắn: im lặng/nhiễu, gảy từng dây, buzz/gõ/giọng, nốt lệch, onset nhanh, nhiều mức âm lượng) kèm expected range pitch/RMS/ZCR/gate/onset.
- **P1** — Chuẩn hóa "DSP contract" mỗi frame (timestamp, freq, cents, clarity, rms, zcr, onset, acousticGate, profileVersion); Trainer chỉ phụ thuộc contract → dễ record/replay + test offline.
- **P2** — Đa âm hợp âm: benchmark Spotify Basic Pitch (latency/CPU/model size/false positive) trước khi đưa vào realtime; hoặc chroma/CQT + chord template nếu chỉ cần xác nhận tập hợp âm đã biết.
- **P2** — Chiến lược offline TF.js: vendor luôn runtime (pin version + license + checksum) nếu cần offline thật; giữ YAMNet đúng vai cổng bối cảnh.
- **P3** — Version hóa guitar profile (schemaVersion, createdAt, device/sampleRate, phiên bản thuật toán calibration) để migrate/yêu cầu calibrate lại khi đổi gate.

## Khuyến nghị gửi source (Work)
Giữ nguyên báo cáo mô tả cho continuity. Khi cần review sâu: ưu tiên cấp Work quyền đọc repo source thật, hoặc tạo repo/branch PRIVATE chỉ chứa songcoach + test + audio fixture tối thiểu. KHÔNG copy nguyên songcoach vào repo bridge public (dễ lộ code + hai nguồn sự thật + lệch phiên bản).

## Verification
- `python3 bridge.py validate` → Valid: 6 handoff(s) (sau khi thêm files/.gitkeep cho handoff phản hồi).
- Diff branch vs main: chỉ file trong exchange/, không chạm code/config, không secret.

## Risks and follow-up
- LỖI LUỒNG đã phát hiện: handoff do Work tạo với files:[] bị thiếu thư mục files/ (git không lưu dir rỗng) → validate fail. Đã vá thủ công bằng files/.gitkeep. NÊN sửa gốc: bridge.py nên coi files/ optional, HOẶC Work luôn tạo files/.gitkeep.
- Repo public — không đưa secret vào handoff.
