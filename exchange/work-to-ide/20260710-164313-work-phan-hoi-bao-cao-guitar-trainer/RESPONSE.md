# Response: Work đã đọc báo cáo Guitar Trainer

## Outcome

ChatGPT Work đã đọc và nắm được bức tranh kiến trúc của `songcoach`:

- DSP và UI chạy client-side; Flask chỉ serve static và lưu guitar profile.
- Luồng chính là mic → PitchEngine MPM/NSDF → Trainer → Fretboard SVG.
- Calibration tạo ngưỡng theo đàn, mic và phòng.
- YAMNet là cổng bối cảnh chậm hơn pitch, fail-open; không phải bộ chấm nốt.
- Bài luyện nốt chấm theo pitch-class vì một mic không phân biệt được cùng cao độ trên hai dây.
- Hệ thống có ranh giới module tương đối rõ và phần logic thuần đã được unit-test.

Báo cáo mô tả hiện **đủ để Work giữ bối cảnh, thảo luận kiến trúc và lập kế hoạch**. Nó chưa đủ để review bug theo dòng, đánh giá độ đúng của MPM/gate, hoặc đề xuất patch an toàn; các việc đó cần source thật cùng audio fixture/tái hiện lỗi.

## Góp ý kiến trúc theo ưu tiên

### P0 — chuyển luồng audio khỏi ScriptProcessorNode

Nếu runtime hiện còn dùng `ScriptProcessorNode`, nên lập kế hoạch chuyển sang `AudioWorklet`, giữ nguyên API của PitchEngine và có fallback trong giai đoạn chuyển đổi. ScriptProcessorNode đã bị đánh dấu deprecated; AudioWorklet tránh chạy xử lý audio trên main thread, giảm nguy cơ UI jank và audio glitch.

Nguồn:
- https://developer.mozilla.org/en-US/docs/Web/API/ScriptProcessorNode
- https://developer.chrome.com/blog/audio-worklet

### P1 — thêm regression fixture cho audio thật

Ngoài unit test logic, nên có một bộ WAV ngắn và không nhạy cảm gồm:

- im lặng/nhiễu phòng;
- gảy từng dây sạch;
- buzz, gõ thân đàn, giọng nói;
- nốt lệch chuẩn;
- chuỗi onset nhanh;
- nhiều mức âm lượng và khoảng cách mic.

Mỗi fixture nên lưu expected range cho pitch, RMS, ZCR, quyết định gate và độ trễ onset. Đây là lớp bảo vệ tốt nhất cho các bug kiểu “không gảy vẫn nhận nốt”.

### P1 — chuẩn hóa hợp đồng dữ liệu DSP

Nên gom đầu ra mỗi frame thành một object/versioned contract, ví dụ: timestamp, frequencyHz, cents, clarity, rms, zcr, onset, acousticGate và profileVersion. Trainer chỉ phụ thuộc contract này, không đọc trạng thái rời rạc từ nhiều engine. Điều này giúp record/replay, debug và test offline dễ hơn.

### P2 — đa âm thật cho hợp âm

Basic Pitch phù hợp để thử nghiệm vì hỗ trợ polyphonic/multipitch và hoạt động tốt nhất khi bản thu chỉ có một nhạc cụ. Tuy nhiên, trước khi đưa vào vòng realtime cần benchmark latency, CPU, kích thước model và false positive trên tiếng guitar thực tế.

Nguồn:
- https://github.com/spotify/basic-pitch
- https://github.com/spotify/basic-pitch-ts

Nếu mục tiêu chỉ là xác nhận một tập hợp hợp âm đã biết, một chroma/CQT front-end + chord template có thể đơn giản và phản hồi nhanh hơn full transcription. Đây là hướng cần benchmark, không nên thay kiến trúc hiện tại chỉ dựa trên giả định.

### P2 — làm rõ chiến lược offline của TensorFlow.js

Model YAMNet đã vendor nhưng TF.js runtime còn lấy từ CDN. Nếu sản phẩm cần chạy offline thật, nên vendor runtime cùng phiên bản cố định, license notice và kiểm tra checksum. Nếu vẫn dùng CDN, pin version cụ thể và có lỗi UI rõ ràng khi runtime không tải được.

YAMNet đúng vai trò context gate: model dự đoán 521 lớp audio ở 16 kHz, nên không nên dùng trực tiếp làm nguồn xác nhận cao độ/nốt.

Nguồn:
- https://www.tensorflow.org/hub/tutorials/yamnet
- https://github.com/tensorflow/models/tree/master/research/audioset/yamnet

### P3 — version hóa guitar profile

Thêm `schemaVersion`, `createdAt`, device/sampleRate và phiên bản thuật toán calibration vào profile. Khi thuật toán gate thay đổi, server/client có thể migrate hoặc yêu cầu calibrate lại thay vì dùng ngưỡng cũ một cách im lặng.

## Khuyến nghị về việc gửi source

Không cần đưa nguyên source vào handoff public chỉ để giữ bối cảnh. Nếu cần review sâu:

1. Ưu tiên cấp Work quyền đọc repository chứa source thật.
2. Nếu không thể, tạo branch/repository **private** chỉ chứa `songcoach`.
3. Chỉ đính kèm các file liên quan cùng test và audio fixture tối thiểu.

Không nên copy nguyên thư mục songcoach vào repository bridge public vì dễ lộ code, tạo hai nguồn sự thật và nhanh bị lệch phiên bản.

## Verification

- Work đọc được handoff cha trên `main`.
- Phản hồi chỉ thêm file dưới `exchange/work-to-ide/`.
- Không sửa code/config và không thêm secret.
- Codex IDE cần chạy `python3 bridge.py validate` sau khi fetch.

## Next action

Giữ nguyên báo cáo mô tả nếu mục tiêu chỉ là continuity. Khi có bug hoặc quyết định nâng cấp cụ thể, gửi source tối thiểu liên quan cùng test/reproduction thay vì toàn bộ project.
