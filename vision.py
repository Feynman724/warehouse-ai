"""Small, local COCO detector and conservative photo checks for the demo."""
import base64
import io
import os
from collections import Counter
from functools import lru_cache
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps, ImageStat, UnidentifiedImageError

MODEL = Path(os.environ.get('WAREHOUSE_VISION_MODEL', '/opt/warehouse-ai/yolov5n.onnx'))
MIMES = {'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WEBP'}
MAX_BYTES = 4 * 1024 * 1024
CLASSES = {
    39: 'bottle', 40: 'wine glass', 41: 'cup', 56: 'chair',
    60: 'dining table', 63: 'laptop', 64: 'mouse', 66: 'keyboard',
    67: 'cell phone', 73: 'book', 74: 'clock', 75: 'vase',
}
ALIASES = {
    'chair': ('椅',), 'dining table': ('桌',), 'laptop': ('笔记本电脑',),
    'mouse': ('鼠标',), 'keyboard': ('键盘',), 'cell phone': ('手机',),
    'book': ('书',), 'bottle': ('瓶',), 'cup': ('杯',),
    'clock': ('钟',), 'vase': ('花瓶',),
}


def decode_photo(data):
    if not isinstance(data, str) or ',' not in data or not data.startswith('data:image/'):
        raise ValueError('请上传 JPEG、PNG 或 WebP 照片')
    prefix, encoded = data.split(',', 1)
    mime = prefix[5:].split(';', 1)[0]
    if mime not in MIMES or ';base64' not in prefix:
        raise ValueError('仅支持 JPEG、PNG 或 WebP 照片')
    if len(encoded) > MAX_BYTES * 4 // 3 + 8:
        raise ValueError('照片不能超过 4 MB')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_BYTES:
            raise ValueError('照片不能超过 4 MB')
        image = Image.open(io.BytesIO(raw))
        if image.format != MIMES[mime]:
            raise ValueError('照片格式与文件内容不符')
        image.load()
        if image.width < 160 or image.height < 160 or image.width * image.height > 24_000_000:
            raise ValueError('照片尺寸须至少 160×160，且不能超过 2400 万像素')
        return ImageOps.exif_transpose(image).convert('RGB'), mime, raw
    except (ValueError, UnidentifiedImageError):
        raise
    except Exception as exc:
        raise ValueError('照片无法读取') from exc


def sanitize_photo(data):
    image, _, _ = decode_photo(data)
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format='JPEG', quality=84, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')


@lru_cache(maxsize=1)
def session():
    if not MODEL.exists():
        return None
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(MODEL), sess_options=options, providers=['CPUExecutionProvider'])


def image_quality(image):
    gray = image.convert('L')
    mean = ImageStat.Stat(gray).mean[0]
    small = np.asarray(gray.resize((256, 256)), dtype=np.float32)
    edges = np.abs(np.diff(small, axis=0)).mean() + np.abs(np.diff(small, axis=1)).mean()
    warnings = []
    if mean < 45: warnings.append('画面偏暗，建议补光后重拍')
    if mean > 235: warnings.append('画面过曝，建议调整光线')
    if edges < 7: warnings.append('画面细节较少或可能失焦，请检查照片')
    return {'brightness': round(mean), 'detail': round(float(edges), 1), 'warnings': warnings}


def _iou(box, boxes):
    x1 = np.maximum(box[0], boxes[:, 0]); y1 = np.maximum(box[1], boxes[:, 1])
    x2 = np.minimum(box[2], boxes[:, 2]); y2 = np.minimum(box[3], boxes[:, 3])
    overlap = np.maximum(x2 - x1, 0) * np.maximum(y2 - y1, 0)
    area1 = (box[2] - box[0]) * (box[3] - box[1])
    area2 = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    return overlap / np.maximum(area1 + area2 - overlap, 1e-6)


def detect(image):
    model = session()
    if model is None:
        return [], 'unavailable'
    width, height = image.size
    scale = min(640 / width, 640 / height)
    nw, nh = round(width * scale), round(height * scale)
    left, top = (640 - nw) // 2, (640 - nh) // 2
    canvas = Image.new('RGB', (640, 640), (114, 114, 114))
    canvas.paste(image.resize((nw, nh), Image.Resampling.BILINEAR), (left, top))
    tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255
    if model.get_inputs()[0].type == 'tensor(float16)': tensor = tensor.astype(np.float16)
    predictions = model.run(None, {model.get_inputs()[0].name: tensor})[0][0].astype(np.float32)
    class_ids = predictions[:, 5:].argmax(axis=1)
    confidence = predictions[:, 4] * predictions[np.arange(len(predictions)), 5 + class_ids]
    keep = np.where((confidence >= .35) & np.isin(class_ids, list(CLASSES)))[0]
    if not len(keep): return [], 'ready'
    keep = keep[np.argsort(-confidence[keep])[:300]]
    boxes = predictions[keep, :4]
    xyxy = np.column_stack((boxes[:, 0] - boxes[:, 2] / 2, boxes[:, 1] - boxes[:, 3] / 2,
                            boxes[:, 0] + boxes[:, 2] / 2, boxes[:, 1] + boxes[:, 3] / 2))
    selected = []
    for idx in range(len(keep)):
        if any(class_ids[keep[idx]] == class_ids[keep[j]] and _iou(xyxy[idx], xyxy[j:j+1])[0] > .45 for j in selected):
            continue
        selected.append(idx)
        if len(selected) >= 50: break
    found = []
    for idx in selected:
        box = xyxy[idx]
        found.append({'label': CLASSES[int(class_ids[keep[idx]])], 'confidence': round(float(confidence[keep[idx]]), 3),
                      'box': [round(max(0, min(1, ((box[j] - (left if j % 2 == 0 else top)) / scale) / (width if j % 2 == 0 else height))), 3) for j in range(4)]})
    return found, 'ready'


def compare_images(before, after):
    # Global difference is a review cue, never a damage verdict.
    a = np.asarray(before.convert('L').resize((64, 64)), dtype=np.float32)
    b = np.asarray(after.convert('L').resize((64, 64)), dtype=np.float32)
    difference = float(np.abs(a - b).mean() / 255)
    return {'difference': round(difference, 3), 'message': '画面差异较明显，请人工对照借出与归还影像' if difference >= .18 else '画面整体接近，仍需人工确认数量和状态'}


def analyze(photo, inventory, expected_item_id, expected_quantity, before_photo=None):
    image, _, _ = decode_photo(photo)
    quality = image_quality(image)
    detections, engine = detect(image)
    counts = Counter(x['label'] for x in detections)
    matched = []
    for label, quantity in counts.items():
        candidates = [x for x in inventory if any(alias in x['name'] for alias in ALIASES.get(label, ())) and x['status'] == 'active']
        if len(candidates) == 1:
            matched.append({'itemId': candidates[0]['id'], 'name': candidates[0]['name'], 'quantity': quantity,
                            'confidence': round(min(x['confidence'] for x in detections if x['label'] == label), 3)})
    target = next((x for x in matched if x['itemId'] == expected_item_id), None)
    other = [x for x in matched if x['itemId'] != expected_item_id]
    if engine != 'ready': status = 'unavailable'
    elif quality['warnings']: status = 'review'
    elif target and target['quantity'] == expected_quantity and not other: status = 'matched'
    elif target or other: status = 'mismatch'
    else: status = 'review'
    comparison = None
    if before_photo:
        try: comparison = compare_images(decode_photo(before_photo)[0], image)
        except ValueError: pass
    return {'engine': engine, 'model': 'YOLOv5n / COCO 80', 'quality': quality, 'detections': detections,
            'matchedItems': matched, 'status': status, 'expected': {'itemId': expected_item_id, 'quantity': expected_quantity},
            'comparison': comparison,
            'note': '仅对模型支持的常见类别给出辅助识别；未识别物资、数量差异和影像变化均由管理员复核。'}


def analyze_batch(photo, inventory, expected, before_photo=None):
    """Compare a single evidence photo with every line of a borrowing order."""
    image, _, _ = decode_photo(photo)
    quality = image_quality(image)
    detections, engine = detect(image)
    by_label = {}
    for detection in detections:
        by_label.setdefault(detection['label'], []).append(detection)
    matched = []
    ambiguous = []
    for label, objects in by_label.items():
        candidates = [item for item in inventory if item['status'] == 'active'
                      and any(alias in item['name'] for alias in ALIASES.get(label, ()))]
        if len(candidates) == 1:
            item = candidates[0]
            matched.append({'itemId': item['id'], 'name': item['name'],
                            'quantity': len(objects),
                            'confidence': round(min(obj['confidence'] for obj in objects), 3)})
        else:
            ambiguous.append(label)
    detected = {item['itemId']: item for item in matched}
    expected_by_id = {item['itemId']: item['quantity'] for item in expected}
    unexpected = [item for item in matched if item['itemId'] not in expected_by_id]
    differences = [{'itemId': item['itemId'], 'expected': item['quantity'],
                    'detected': detected.get(item['itemId'], {}).get('quantity', 0)}
                   for item in expected if detected.get(item['itemId'], {}).get('quantity', 0) != item['quantity']]
    # COCO has no class for most warehouse materials; absence is never evidence of zero.
    if engine != 'ready': status = 'unavailable'
    elif unexpected or any(d['detected'] for d in differences): status = 'mismatch'
    elif differences or ambiguous or quality['warnings']: status = 'review'
    else: status = 'matched'
    comparison = None
    if before_photo:
        try: comparison = compare_images(decode_photo(before_photo)[0], image)
        except ValueError: pass
    return {'engine': engine, 'model': 'YOLOv5n / COCO 80', 'quality': quality,
            'detections': detections, 'matchedItems': matched, 'expectedItems': expected,
            'differences': differences, 'ambiguousLabels': ambiguous, 'unexpectedItems': unexpected,
            'status': status, 'comparison': comparison,
            'autoEligible': status == 'matched' and bool(expected) and
                            all(detected[item['itemId']]['confidence'] >= .75 for item in expected),
            'note': '同框照片用于留痕和辅助识别。现有模型只支持少数通用类别；帐篷、喇叭、扫帚等未覆盖物资必须人工核对，不能自动扣库存。'}
