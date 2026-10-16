import os, sys, hashlib, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_addon_skeleton import AddonCase
def sha(d): return hashlib.sha256(open(os.path.join(d, "sqlite.db"), "rb").read()).hexdigest()[:10]
class T(AddonCase):
    def test_x(self):
        self.bind()
        env = dict(os.environ, PYTHONHASHSEED="0")
        out = []
        for i in range(4):
            self.cli("action=status", env=env); out.append(sha(self.dir))
        p, _ = self.cli("action=check,dry_run=1", env=env); out.append(sha(self.dir))
        print("SHAS", out)
if __name__ == "__main__":
    unittest.main()
