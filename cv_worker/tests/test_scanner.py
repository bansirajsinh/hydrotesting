import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / 'scan_media.py'
spec = importlib.util.spec_from_file_location('scan_media', MODULE)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class PlateNormalizationTests(unittest.TestCase):
    def test_normalizes_whitespace_and_case(self):
        self.assertEqual(scanner.normalize_plate(' gj 01 ab 1234 '), 'GJ01AB1234')

    def test_common_indian_shape(self):
        self.assertEqual(scanner.shape_score('GJ01AB1234'), 1.0)
        self.assertEqual(scanner.shape_score('GJ01ABC1234'), 1.0)

    def test_bharat_series_shape(self):
        self.assertEqual(scanner.shape_score('21BH1234AA'), 1.0)
        self.assertLess(scanner.shape_score('21BH1234IO'), 1.0)  # retained only as a weak review candidate

    def test_rejects_short_text(self):
        self.assertEqual(scanner.shape_score('CAR'), 0.0)

    def test_preserves_ambiguous_characters(self):
        self.assertEqual(scanner.normalize_plate('GJ01A81234'), 'GJ01A81234')

    def test_consensus_prefers_multiple_frames(self):
        observations = [
            {'plate':'GJ01AB1234','rawText':'GJ01AB1234','confidence':.72,'frameIndex':1,'timestampSeconds':.3,'engine':'test'},
            {'plate':'GJ01AB1234','rawText':'GJ01AB1234','confidence':.78,'frameIndex':4,'timestampSeconds':1.2,'engine':'test'},
            {'plate':'GJ01AC1234','rawText':'GJ01AC1234','confidence':.81,'frameIndex':7,'timestampSeconds':2.1,'engine':'test'},
        ]
        result = scanner.combine_observations(observations)
        self.assertEqual(result[0]['plate'], 'GJ01AB1234')
        self.assertEqual(result[0]['supportFrames'], 2)

    def test_multiple_same_frame_reads_do_not_fake_consensus(self):
        observations = [
            {'plate': 'GJ01AB1234', 'rawText': 'GJ01AB1234', 'confidence': .92, 'frameIndex': 10, 'timestampSeconds': .4, 'engine': 'test'},
            {'plate': 'GJ01AB1234', 'rawText': 'GJ01AB1234', 'confidence': .89, 'frameIndex': 10, 'timestampSeconds': .4, 'engine': 'test'},
        ]
        result = scanner.combine_observations(observations)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['supportFrames'], 1)

    def test_candidate_keeps_ocr_characters_unmodified(self):
        value = scanner.normalize_plate('GJ 01 A8 1234')
        self.assertEqual(value, 'GJ01A81234')


if __name__ == '__main__':
    unittest.main()
