"""Installed SDK interface checks; these never prove VM execution/persistence."""
import inspect
import os
import tempfile
import unittest
import boxlite


class InstalledSDKBoundary(unittest.TestCase):
    def test_pinned_native_api_matches_adapter_keywords(self):
        self.assertEqual(boxlite.__version__, '0.11.0')
        self.assertTrue({'command', 'args', 'env', 'timeout_secs', 'cwd'} <= set(inspect.signature(boxlite.Box.exec).parameters))
        self.assertTrue({'execution_id', 'stdin'} <= set(inspect.signature(boxlite.Box.attach).parameters))
        self.assertTrue(hasattr(boxlite.BoxInfo, 'state'))
        self.assertTrue(hasattr(boxlite.BoxStateInfo, 'running'))
        self.assertTrue(hasattr(boxlite.Boxlite, 'get_info'))
        self.assertTrue(hasattr(boxlite.Boxlite, 'close'))

    def test_explicit_retention_options_are_accepted_by_native_sdk(self):
        options = boxlite.BoxOptions(image='python@sha256:' + '1' * 64, cpus=1, memory_mib=256,
                                    disk_size_gb=1, auto_remove=False, auto_delete=0, detach=True)
        self.assertFalse(options.auto_remove)
        self.assertEqual(options.auto_delete, 0)
        self.assertTrue(options.detach)
        self.assertEqual(options.disk_size_gb, 1)
        # This constructor check does not validate image availability or enforcement.
        security = boxlite.SecurityOptions.standard()
        self.assertTrue(security.jailer_enabled)
        self.assertTrue(security.seccomp_enabled)

    @unittest.skipIf(os.path.exists('/dev/kvm'), 'This negative test applies only to a host without KVM device')
    def test_native_runtime_refuses_missing_kvm(self):
        with tempfile.TemporaryDirectory(prefix='workflow-qa-sdk-') as path:
            with self.assertRaises(boxlite.errors.UnsupportedError):
                boxlite.Boxlite(boxlite.Options(home_dir=path))


if __name__ == '__main__':
    unittest.main(verbosity=2)
