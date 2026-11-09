import pytest
from auth import register_user, authenticate_user, get_user_by_id


@pytest.fixture
def db(clean_db):
    return clean_db


class TestRegister:
    def test_register_returns_id(self, db):
        uid = register_user(db, "Luna", "Larcher", "luna", "pass1234")
        assert uid == 1

    def test_register_stores_user(self, db):
        register_user(db, "Luna", "Larcher", "luna", "pass1234")
        user = db.execute("SELECT * FROM users WHERE username = 'luna'").fetchone()
        assert user["first_name"] == "Luna"
        assert user["last_name"] == "Larcher"

    def test_password_is_hashed(self, db):
        register_user(db, "Luna", "Larcher", "luna", "pass1234")
        user = db.execute("SELECT * FROM users WHERE username = 'luna'").fetchone()
        assert user["password_hash"] != "pass1234"
        assert user["password_hash"].startswith("scrypt:") or user["password_hash"].startswith("pbkdf2:")

    def test_duplicate_username_raises(self, db):
        register_user(db, "Luna", "Larcher", "luna", "pass1234")
        with pytest.raises(ValueError, match="username already taken"):
            register_user(db, "Other", "Person", "luna", "pass5678")

    def test_empty_first_name_raises(self, db):
        with pytest.raises(ValueError, match="first name is required"):
            register_user(db, "", "Larcher", "luna", "pass1234")

    def test_empty_last_name_raises(self, db):
        with pytest.raises(ValueError, match="last name is required"):
            register_user(db, "Luna", "", "luna", "pass1234")

    def test_empty_username_raises(self, db):
        with pytest.raises(ValueError, match="username must be at least 3"):
            register_user(db, "Luna", "Larcher", "", "pass1234")

    def test_short_password_raises(self, db):
        with pytest.raises(ValueError, match="password must be at least 8"):
            register_user(db, "Luna", "Larcher", "luna", "hi")


class TestLogin:
    def test_correct_credentials(self, db):
        register_user(db, "Luna", "Larcher", "luna", "pass1234")
        user = authenticate_user(db, "luna", "pass1234")
        assert user is not None
        assert user["username"] == "luna"

    def test_wrong_password(self, db):
        register_user(db, "Luna", "Larcher", "luna", "pass1234")
        assert authenticate_user(db, "luna", "wrongpass") is None

    def test_username_spaces_are_trimmed(self, db):
        register_user(db, "Luna", "Larcher", " luna ", "pass1234")
        assert authenticate_user(db, " luna ", "pass1234") is not None

    def test_nonexistent_user(self, db):
        assert authenticate_user(db, "nobody", "pass1234") is None


class TestGetUser:
    def test_existing_user(self, db):
        uid = register_user(db, "Luna", "Larcher", "luna", "pass1234")
        user = get_user_by_id(db, uid)
        assert user["username"] == "luna"

    def test_nonexistent_id(self, db):
        assert get_user_by_id(db, 999) is None
