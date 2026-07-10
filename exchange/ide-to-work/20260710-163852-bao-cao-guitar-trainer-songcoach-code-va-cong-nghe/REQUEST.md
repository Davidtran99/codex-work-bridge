# Request: Báo cáo Guitar Trainer (songcoach) — toàn bộ code & công nghệ

## Goal
Cung cấp cho ChatGPT Work bức tranh đầy đủ về sub-app **Guitar Trainer (songcoach)** — web luyện chơi/bấm nốt guitar chạy trong trình duyệt — gồm: danh sách file code, vai trò từng file, và stack công nghệ. Đây là báo cáo để Work nắm bối cảnh; KHÔNG yêu cầu sửa gì.

## Context
- Vị trí: `guitar-augmented-reality/songcoach` (một sub-app trong repo AR chính).
- Kiến trúc: **toàn bộ DSP + UI chạy client-side trong trình duyệt** (Web Audio API). Flask chỉ serve static + lưu "hồ sơ đàn" (guitar profile).
- Server nền chạy standalone qua launchd tại `~/Library/Application Support/SongCoach/app`, port **5002**.
- Đã viết lại từ game kiểu "highway/Yousician" thành trình LUYỆN BẤM PHÍM hiện đại: hiện cả cần đàn, tô ô cần bấm, hiện hợp âm, nhận nốt gảy đơn, rung lắc khi sai.

## Tổng quan file code

### Front-end engine (static/js/) — thuần, unit-test được
| File | Dòng | Vai trò |
| --- | --- | --- |
| `theory.js` | 119 | Model nhạc lý thuần: cần đàn chuẩn 6 dây × 22 phím, MIDI/tên nốt từng ô, thư viện thế bấm hợp âm (C, A, Am, Am7, G, E, Em, Em7, D, Dm, F, Cmaj7…) kèm ngón + dây câm. Không DOM, không audio. |
| `pitch.js` | 321 | **PitchEngine** — nhận cao độ đơn âm thời gian thực bằng **McLeod Pitch Method (MPM)** trên **NSDF** (Normalised Square Difference Function) + nội suy đỉnh parabol. Khử DC offset, band gates theo tần số, cấu hình a4 động, ring buffer 1.2s, **timbre gate bằng ZCR** (zero-crossing rate) lọc hiss/buzz/gõ. |
| `fretboard.js` | 231 | Renderer cần đàn **SVG** hiện đại: nut, mọi phím, 6 dây (dày dần), inlay, số phím, ô click. Overlay: ô target nhấp nháy, thế hợp âm (chấm màu + số ngón + ✕ dây câm), flashHit (vòng xanh/đỏ), shake() rung cần đàn khi sai. |
| `trainer.js` | 287 | Logic luyện tập trên PitchEngine + FretboardView. 3 chế độ: **Luyện nốt** (onset detection + refractory 60ms, khớp pitch-class trong cửa sổ cents), **Hợp âm** (xác nhận nhiều frame chống bội âm nhảy), **Khám phá**. |
| `calibration.js` | 206 | Hệ thống **"Hồ sơ đàn"**: ghi ~15s tiếng đàn qua mic → phân tích thuần (noiseFloor percentile, signalRms median, tuningOffsetCents → a4Hz, dải tần) → suy ra ngưỡng gate cho ĐÚNG đàn+mic+phòng này. gradeProfile() chấm điểm. |
| `yamnet.js` | 165 | Cổng âm học tùy chọn phân biệt GUITAR vs giọng nói/tạp âm bằng **YAMNet** (Google, 521 lớp, TensorFlow.js). Lazy-load, resample 16k, so nhóm music-vs-voice, throttle + hold, **fail-open** khi lỗi. |
| `app.js` | 460 | Controller nối mic → PitchEngine → Trainer → FretboardView + đọc cao độ trực tiếp; wizard calibration 3 bước; toggle gate YAMNet; nạp profile lúc init. |

### Giao diện
| File | Dòng | Vai trò |
| --- | --- | --- |
| `templates/index.html` | 141 | Trang chính (Flask render). |
| `static/css/style.css` | 243 | Giao diện tối hiện đại + modal wizard calibration + toggle CSS. |

### Back-end
| File | Dòng | Vai trò |
| --- | --- | --- |
| `server.py` | 117 | Flask (port 5002). Serve page/static + `/api/profile` GET/POST/DELETE lưu guitar profile JSON (ghi atomic ra `~/Library/Application Support/SongCoach/data/`, NGOÀI app dir để rsync --delete không xoá). |
| `package.json` | — | type=commonjs; script test chạy 4 file .cjs. |

### Vendor (offline)
- `static/vendor/yamnet/` — model YAMNet TF.js: `model.json` + `group1-shard{1..4}of4.bin` (~16MB) + `yamnet_class_map.csv` (521 lớp).

### Test (Node, .cjs)
| File | Dòng | Phủ |
| --- | --- | --- |
| `tests/test_calibration.cjs` | 199 | Phân tích calibration |
| `tests/test_trainer.cjs` | 250 | Logic luyện tập (onset, pitch-class, hợp âm) |
| `tests/test_fretboard_dom.cjs` | 113 | Renderer SVG (jsdom) |
| `tests/test_yamnet.cjs` | 120 | Cổng YAMNet |

## Stack công nghệ
- **Front-end DSP:** Web Audio API (getUserMedia, AnalyserNode/ScriptProcessor), thuật toán MPM/NSDF tự cài (không thư viện pitch ngoài).
- **Nhận diện âm học:** TensorFlow.js + YAMNet (Apache-2.0), vendor offline; TF.js runtime tải từ CDN jsdelivr.
- **Render:** SVG thuần (không canvas) để sắc nét + click từng ô + theme qua CSS var.
- **Back-end:** Python 3 + Flask (chỉ serve static + lưu profile JSON, ghi atomic).
- **Chạy nền:** launchd (macOS), bản standalone dùng /usr/bin/python3 hệ thống (TCC chặn agent nền đọc ~/Documents nên không dùng venv trong đó).
- **Test:** Node.js thuần + jsdom, module CommonJS (.cjs) vì thư mục cha là type:module.
- **Trạng thái verify:** 48–49 test JS + 90 pytest (geometry AR) xanh.

## Điểm kỹ thuật đáng chú ý (giới hạn thật)
- 1 mic + đơn âm KHÔNG tách được cùng một nốt trên 2 dây khác nhau (âm giống hệt) → chấm theo **pitch-class**. Đây là giới hạn vật lý, ghi rõ trên UI.
- Timbre gate dùng **ZCR** thay vì harmonicity (đã thử harmonicity → chặn nhầm cả tiếng đàn thật).
- YAMNet là cổng bối cảnh ~1s (chậm hơn pitch), so NHÓM music-vs-voice chứ không ngưỡng tuyệt đối, fail-open.
- Nguyên nhân bug "nhận nốt khi không gảy": ngưỡng RMS quá sát nền nhiễu → fix bằng gate ≥3–4× noiseFloor.

## Requested work
- [ ] ChatGPT Work đọc và xác nhận đã nắm bức tranh Guitar Trainer.
- [ ] (Tùy chọn) Work góp ý kiến trúc / hướng nâng cấp nếu muốn (VD: đa âm thật cho hợp âm bằng Spotify Basic Pitch, vendor luôn tf.min.js).
- [ ] KHÔNG cần sửa code — đây là báo cáo bối cảnh.

## Allowed scope
- Chỉ đọc/ghi trong `exchange/` của bridge. KHÔNG chạm mã nguồn songcoach hay repo AR.
- KHÔNG đặt secret vào handoff (repo public).

## Acceptance criteria
- [ ] `python3 bridge.py validate` xanh.
- [ ] Work xác nhận đọc được báo cáo này.

## Verification
```
cd ~/Documents/codex-work-bridge
python3 bridge.py validate
python3 bridge.py status
```

## Blockers or risks
- Repo đang public — không đưa dữ liệu nhạy cảm vào handoff.
