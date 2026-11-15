import sqlite3,unittest,pathlib
class DatabaseTest(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.db.executescript(pathlib.Path('migrations/0001_initial.sql').read_text())
  self.db.executescript("INSERT INTO users VALUES('u','a@example.com','Owner');INSERT INTO shops(id,name,created_at) VALUES('a','A','2026-01-01'),('b','B','2026-01-01');INSERT INTO products VALUES('p','a','Rice','r','Rice','kg',100,50,1000,0,'',1);")
 def sale(self,id='s',shop='a'):
  self.db.execute('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?)',(id,shop,'u','2026-01-01','2026-01-01','Cash',100,0,100,100))
 def line(self,id='s',shop='a',qty=1000,price=100):
  self.db.execute('INSERT INTO sale_lines VALUES(?,?,?,?,?,?,?)',(shop,id,'p','Rice',qty,price,50))
 def test_deduct_once(self):
  self.sale();self.line();self.assertEqual(self.db.execute('SELECT stock FROM products').fetchone()[0],0)
  with self.assertRaises(sqlite3.IntegrityError):self.sale()
 def test_no_cross_shop_stock(self):
  self.sale(shop='b')
  with self.assertRaises(sqlite3.IntegrityError):self.line(shop='b')
 def test_atomic_conflict(self):
  self.db.commit()
  with self.assertRaises(sqlite3.IntegrityError):
   with self.db:self.sale();self.line(qty=2000)
  self.assertEqual(self.db.execute('SELECT count(*) FROM sales').fetchone()[0],0)
  self.assertEqual(self.db.execute('SELECT stock FROM products').fetchone()[0],1000)
 def test_reject_stale_price(self):
  self.sale()
  with self.assertRaises(sqlite3.IntegrityError):self.line(price=99)
 def test_reject_expired(self):
  self.db.execute("UPDATE products SET expiry='2020-01-01'");self.sale()
  with self.assertRaises(sqlite3.IntegrityError):self.line()
if __name__=='__main__':unittest.main()
