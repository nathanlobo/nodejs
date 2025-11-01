#include <iostream>
using namespace std;
class BankAccount {
private:
    string depositor_name;
    string account_number;
    string account_type;
    double balance_amount;
public:
    void setData() {
        cout << "===Enter Bank Account Details===\n\nEnter depositor name: ";
        getline(cin, depositor_name);
        cout << "Enter account number: ";
        getline(cin, account_number);
        cout << "Enter account type: ";
        getline(cin, account_type);
        cout << "Enter initial balance: ";
        cin >> balance_amount;
    }
    void deposit(double amount) {
        if (amount > 0) {
            balance_amount += amount;
            cout << "Amount deposited successfully.\n";
            cout << "Balance: " << balance_amount << endl;
        } else {
            cout << "Invalid deposit amount.\n";
        }
    }
    void withdraw(double amount) {
        if (amount <= 0) {
            cout << "Invalid withdrawal amount.\n";
        } else if (amount > balance_amount) {
            cout << "Insufficient balance.\n";
        } else {
            balance_amount -= amount;
            cout << "Amount withdrawn successfully.\n";
            cout << "Balance: " << balance_amount << endl;
        }
    }
    void display() {
        cout << "Depositor Name: " << depositor_name << endl;
        cout << "Account Number: " << account_number << endl;
        cout << "Account Type: " << account_type << endl;
        cout << "Balance Amount: " << balance_amount << endl;
    }
};
int main() {
    BankAccount acc;
    acc.setData();
    int choice;
    double amount;
    while (true){
        cout << "\nChoose From Below Options:\n1. Deposit\n2. Withdraw\n3. Display Account Info\n4. Exit\nEnter choice: ";
        cin >> choice;
        if (choice == 1) {
            cout << "Enter amount to deposit: ";
            cin >> amount;
            acc.deposit(amount);
        } else if (choice == 2) {
            cout << "Enter amount to withdraw: ";
            cin >> amount;
            acc.withdraw(amount);
        } else if (choice == 3) {
            acc.display();
        } else if (choice == 4) {
            cout << "Exiting Program";
            break;
        }
        else {
            cout << "Invalid choice.\n";
        }
    }
    return 0;
}