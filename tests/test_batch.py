"""Integration checks for one-photo, multi-item inventory accounting."""
import pathlib
import sys
import tempfile
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def fake_analysis(photo, inventory, expected, before=None):
    recognized = [] if photo == 'unknown' else [
        {'itemId': entry['itemId'], 'name': next(item['name'] for item in inventory if item['id'] == entry['itemId']),
         'quantity': entry['quantity'], 'confidence': .91} for entry in expected]
    return {'expectedItems': expected, 'matchedItems': recognized,
            'status': 'review' if photo == 'unknown' else 'matched',
            'autoEligible': photo != 'unknown', 'detections': [], 'quality': {'warnings': []}, 'note': 'test'}


sys.modules['vision'] = types.SimpleNamespace(sanitize_photo=lambda photo: photo, analyze_batch=fake_analysis)
import server  # noqa: E402


class BatchLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        server.DB = pathlib.Path(self.temp.name) / 'warehouse.db'
        server.init()
        self.order = server.mutate('/api/batch/create', {
            'items': [{'itemId': 'table', 'quantity': 2}, {'itemId': 'chair', 'quantity': 3}],
            'borrowDate': '2026-10-16', 'returnDate': '2026-10-20', 'purpose': '活动'}, 'u1')['id']
        server.mutate('/api/batch/decision', {'id': self.order, 'decision': 'approved'}, 'admin')

    def tearDown(self):
        self.temp.cleanup()

    def available(self, item):
        return server.one('SELECT available FROM inventory WHERE id=?', (item,))['available']

    def test_auto_borrow_and_reviewed_return_are_atomic(self):
        result = server.mutate('/api/batch/capture', {'orderId': self.order, 'photo': 'matched'}, 'u1')
        self.assertTrue(result['autoPosted'])
        self.assertEqual((self.available('table'), self.available('chair')), (8, 31))
        returned = server.mutate('/api/batch/capture', {'orderId': self.order, 'photo': 'unknown'}, 'u1')
        self.assertFalse(returned['autoPosted'])
        with self.assertRaises(ValueError):
            server.mutate('/api/batch/review', {'id': returned['id'], 'items': [
                {'itemId': 'table', 'quantity': 2, 'damaged': 0},
                {'itemId': 'chair', 'quantity': 2, 'damaged': 0}]}, 'admin')
        self.assertEqual((self.available('table'), self.available('chair')), (8, 31))
        server.mutate('/api/batch/review', {'id': returned['id'], 'items': [
            {'itemId': 'table', 'quantity': 2, 'damaged': 0},
            {'itemId': 'chair', 'quantity': 2, 'damaged': 1}]}, 'admin')
        self.assertEqual((self.available('table'), self.available('chair')), (10, 33))
        self.assertEqual(server.one('SELECT damaged FROM inventory WHERE id="chair"')['damaged'], 1)
        self.assertEqual(server.state('u1')['batchOrders'][0]['status'], 'returned')

    def test_unrecognized_photo_never_auto_deducts(self):
        result = server.mutate('/api/batch/capture', {'orderId': self.order, 'photo': 'unknown'}, 'u1')
        self.assertFalse(result['autoPosted'])
        self.assertEqual((self.available('table'), self.available('chair')), (10, 34))
        self.assertEqual(server.state('u1')['batchOrders'][0]['status'], 'awaiting_borrow_review')


if __name__ == '__main__':
    unittest.main()
